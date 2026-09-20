# Render the vector logo geometry at each native icon size. No external tools needed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot 'assets'
New-Item -ItemType Directory -Force -Path $output | Out-Null
function RenderLogo([int]$size) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.ScaleTransform($size / 512.0, $size / 512.0)
    $bg = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#102639'))
    $shape = [Drawing.Drawing2D.GraphicsPath]::new()
    foreach ($arc in @(@(8,8,180),@(280,8,270),@(280,280,0),@(8,280,90))) { $shape.AddArc($arc[0],$arc[1],224,224,$arc[2],90) }
    $shape.CloseFigure(); $g.FillPath($bg,$shape)
    foreach ($line in @(@('#5EF0C1',128,148,128,340,230,340),@('#65BFFF',240,176,310,340,396,148))) {
        $color = [Drawing.ColorTranslator]::FromHtml($line[0])
        $pen = [Drawing.Pen]::new($color,40)
        $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
        $points = [Drawing.PointF[]]@([Drawing.PointF]::new($line[1],$line[2]),[Drawing.PointF]::new($line[3],$line[4]),[Drawing.PointF]::new($line[5],$line[6]))
        $g.DrawLines($pen,$points); $pen.Dispose()
    }
    foreach ($node in @(@('#5EF0C1',128,148),@('#65BFFF',396,148))) {
        $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($node[0]))
        $g.FillEllipse($brush,($node[1]-28),($node[2]-28),56,56); $brush.Dispose()
    }
    $stream = [IO.MemoryStream]::new()
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    $data = $stream.ToArray()
    $stream.Dispose(); $shape.Dispose(); $bg.Dispose(); $g.Dispose(); $bitmap.Dispose()
    return ,$data
}
$sizes = @(16,24,32,48,64,128,256)
$images = @{}; foreach ($size in ($sizes + @(512,1024))) { $images[$size] = RenderLogo $size }
[IO.File]::WriteAllBytes("$output/lanvibes.png",$images[256])
$writer = [IO.BinaryWriter]::new([IO.File]::Create("$output/lanvibes.ico"))
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($size in $sizes) {
    $dimension = if ($size -eq 256) { 0 } else { $size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$size].Length); $writer.Write([uint32]$offset)
    $offset += $images[$size].Length
}
foreach ($size in $sizes) { $writer.Write([byte[]]$images[$size]) }; $writer.Dispose()
function WriteBigEndian($writer,[int]$number) { $bytes=[BitConverter]::GetBytes($number); [Array]::Reverse($bytes); $writer.Write($bytes) }
$writer = [IO.BinaryWriter]::new([IO.File]::Create("$output/lanvibes.icns"))
$total = 8; foreach ($size in @(128,256,512,1024)) { $total += 8 + $images[$size].Length }
$writer.Write([Text.Encoding]::ASCII.GetBytes('icns')); WriteBigEndian $writer $total
foreach ($pair in @(@('ic07',128),@('ic08',256),@('ic09',512),@('ic10',1024))) {
    $writer.Write([Text.Encoding]::ASCII.GetBytes($pair[0])); WriteBigEndian $writer (8+$images[$pair[1]].Length)
    $writer.Write([byte[]]$images[$pair[1]])
}; $writer.Dispose()
