# Register metadata only; never install or run the service binary.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot '../setup-service.mjs') --platform windows @args
exit $LASTEXITCODE
