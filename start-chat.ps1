# Start opencode-chat (double-click friendly)
$here = Split-Path $MyInvocation.MyCommand.Definition -Parent
node "$here\server.mjs" --open --web-port 8787 --opencode-port 4096
