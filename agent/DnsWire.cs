using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

// Small bounded DNS reader: queries A/AAAA only, verifies transaction and echoed question,
// supports compressed names, rejects malformed messages, and never trusts response lengths.
public static class DnsWire
{
    public static byte[] BuildQuery(string name, ushort type, ushort id)
    {
        if (type is not (1 or 28)) throw new ArgumentException("Only A/AAAA queries are supported.");
        using var buffer = new MemoryStream();
        var header = new byte[12];
        BinaryPrimitives.WriteUInt16BigEndian(header, id);
        header[2] = 1; // recursion desired
        header[5] = 1;
        buffer.Write(header);
        foreach (var label in name.TrimEnd('.').Split('.'))
        {
            if (label.Length is < 1 or > 63 || label.Any(c => c > 127)) throw new ArgumentException("Invalid DNS name.");
            buffer.WriteByte((byte)label.Length);
            buffer.Write(Encoding.ASCII.GetBytes(label));
        }
        buffer.WriteByte(0);
        buffer.WriteByte(0); buffer.WriteByte((byte)type);
        buffer.WriteByte(0); buffer.WriteByte(1);
        if (buffer.Length > 271) throw new ArgumentException("DNS name too long.");
        return buffer.ToArray();
    }

    public static async Task<string> QueryAsync(IPAddress server, string name, ushort type, bool tcp, CancellationToken ct)
    {
        var id = (ushort)RandomNumberGenerator.GetInt32(65536);
        var query = BuildQuery(name, type, id);
        byte[] response;
        if (tcp)
        {
            using var client = new TcpClient(server.AddressFamily);
            await client.ConnectAsync(server, 53, ct);
            var stream = client.GetStream();
            var prefix = new byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(prefix, (ushort)query.Length);
            await stream.WriteAsync(prefix, ct);
            await stream.WriteAsync(query, ct);
            await stream.ReadExactlyAsync(prefix, ct);
            var length = BinaryPrimitives.ReadUInt16BigEndian(prefix);
            if (length < 12) throw new IOException("Short DNS response.");
            response = new byte[length];
            await stream.ReadExactlyAsync(response, ct);
        }
        else
        {
            using var client = new UdpClient(server.AddressFamily);
            client.Connect(server, 53);
            await client.SendAsync(query, ct);
            response = (await client.ReceiveAsync(ct)).Buffer;
        }
        return Parse(response, name, type, id);
    }

    public static string Parse(byte[] message, string expectedName, ushort type, ushort id)
    {
        int Read16(int offset)
        {
            if (offset < 0 || offset + 2 > message.Length) throw new IOException("Truncated DNS response.");
            return BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(offset));
        }
        if (message.Length < 12 || Read16(0) != id || (message[2] & 0x80) == 0 || (message[2] & 0x78) != 0)
            throw new IOException("Mismatched DNS response.");
        if (Read16(4) != 1) throw new IOException("Unexpected DNS question count.");
        var cursor = 12;
        var question = ReadName(message, ref cursor);
        if (!question.Equals(expectedName.TrimEnd('.'), StringComparison.OrdinalIgnoreCase) || Read16(cursor) != type || Read16(cursor + 2) != 1)
            throw new IOException("Mismatched DNS question.");
        cursor += 4;
        var code = message[3] & 15;
        if (code != 0) throw new IOException($"DNS RCODE {code} ({(code == 3 ? "NXDOMAIN" : code == 2 ? "SERVFAIL" : code == 5 ? "REFUSED" : "error")}); resolver replied but lookup did not succeed.");
        if ((message[2] & 2) != 0) throw new IOException("Truncated DNS response; inspect the TCP result.");
        var answers = new List<string>();
        var count = Read16(6);
        for (var i = 0; i < count; i++)
        {
            _ = ReadName(message, ref cursor);
            var answerType = Read16(cursor);
            var answerClass = Read16(cursor + 2);
            var length = Read16(cursor + 8);
            cursor += 10;
            if (cursor + length > message.Length) throw new IOException("Truncated DNS answer.");
            if (answerClass == 1 && answerType == type && ((type == 1 && length == 4) || (type == 28 && length == 16)))
                answers.Add(new IPAddress(message.AsSpan(cursor, length)).ToString());
            cursor += length;
        }
        return answers.Count > 0 ? $"NOERROR: {string.Join(", ", answers.Distinct())}" : "NOERROR with no requested address records; absence of AAAA is not an IPv6 connectivity test.";
    }

    private static string ReadName(byte[] message, ref int cursor)
    {
        var labels = new List<string>();
        var offset = cursor;
        var jumped = false;
        var visited = new HashSet<int>();
        var total = 0;
        while (true)
        {
            if (offset >= message.Length || !visited.Add(offset)) throw new IOException("Invalid DNS name pointer.");
            var length = message[offset++];
            if ((length & 0xc0) == 0xc0)
            {
                if (offset >= message.Length) throw new IOException("Truncated DNS pointer.");
                if (!jumped) cursor = offset + 1;
                jumped = true;
                offset = ((length & 63) << 8) | message[offset];
                continue;
            }
            if (length > 63 || offset + length > message.Length || (total += length + 1) > 255) throw new IOException("Invalid DNS label.");
            if (length == 0) { if (!jumped) cursor = offset; return string.Join('.', labels); }
            labels.Add(Encoding.ASCII.GetString(message, offset, length));
            offset += length;
        }
    }
}
