@echo off
rem Double-click to run: starts the local server and opens the jelly in your browser.
cd /d "%~dp0"
start "" http://localhost:5173
node serve.mjs
