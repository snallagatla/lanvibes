# Optional Azure Artifact Signing

Signing is optional and currently deferred. Unsigned pilot builds require no Azure account. No account identifiers or credentials are supplied with this project.

To enable signing, check Microsoft's current eligibility requirements, complete identity validation, create a Public Trust certificate profile, and assign the signing identity the Artifact Signing Certificate Profile Signer role. Identity validation requires the Artifact Signing Identity Verifier role.

Copy signing-metadata.example.json to the ignored local signing-metadata.json. Replace placeholders with your regional endpoint, account name, and certificate profile name. Keep credentials out of these files. Install compatible Microsoft Artifact Signing client tools and authenticate your own signing identity. CI should use workload identity.

```powershell
./packaging/build-windows-bundle.ps1 `
  -SigningMetadata ./packaging/signing-metadata.json `
  -SignToolPath 'C:/tools/x64/signtool.exe' `
  -DlibPath 'C:/tools/x64/Azure.CodeSigning.Dlib.dll'
```

The build signs and verifies application binaries, MSI packages, the detached bundle engine, and the final installer in that order. Errors stop the build. Without signing arguments, outputs are labeled unsigned. Rebuild after modifying packaged files. Windows signing does not replace Apple Developer ID signing and notarization.

References: [Microsoft signing integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations), [role assignment](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles), [WiX signing](https://docs.firegiant.com/wix/tools/signing/).
