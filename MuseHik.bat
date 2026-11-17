@echo off
rem Double-click to start MuseHik in your browser. Close this window to stop it.
rem For a desktop shortcut: right-click this file > Show more options > Send to > Desktop (create shortcut).
title MuseHik
cd /d "%~dp0backend"
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
node launch.mjs
if errorlevel 1 pause
