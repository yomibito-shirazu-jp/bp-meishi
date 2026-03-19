@echo off
chcp 65001 >nul
echo ============================================
echo   Adobe InDesign MCP サーバー起動
echo ============================================
echo.

set BASE=%~dp0mcp\adb-mcp-main\adb-mcp-main

echo [1/2] プロキシサーバーを起動中...
start "ADB Proxy Server" cmd /k "cd /d %BASE%\adb-proxy-socket && node proxy.js"
timeout /t 2 /nobreak >nul

echo [2/2] InDesign MCPサーバーを起動中...
start "InDesign MCP Server" cmd /k "cd /d %BASE%\mcp && uv run id-mcp.py"

echo.
echo ============================================
echo   起動完了！
echo   - プロキシ: ws://localhost:49300
echo   - MCP: stdio (InDesign)
echo.
echo   次の手順:
echo   1. InDesign を起動
echo   2. UXP Developer Tool で uxp\id\manifest.json をロード
echo   3. InDesign のプラグインパネルで「Connect」を押す
echo ============================================
echo.
pause
