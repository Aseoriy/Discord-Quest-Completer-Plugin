ping -n 1 github.com >nul 2>&1
if errorlevel 1 (
    echo No internet connection detected. Please check your connection and try again.   
    pause
    exit /b 1
)
winget install nodejs
winget install git
winget install python
cd /d "%USERPROFILE%\Documents"
git clone https://github.com/Vendicated/Vencord.git

cd /d "%USERPROFILE%\Documents\Vencord\src\plugins"
mkdir QuestAutoComplete
cd QuestAutoComplete

curl.exe -fLo index.tsx https://raw.githubusercontent.com/ck5414/Discord-Quest-Completer-Plugin/refs/heads/main/index.tsx
curl.exe -fLo native.ts https://raw.githubusercontent.com/ck5414/Discord-Quest-Completer-Plugin/refs/heads/main/native.ts

cd /d "%USERPROFILE%\Documents\Vencord"

call npm install --global pnpm
call pnpm install
call pnpm build
call pnpm inject

cd .
rmdir /s /q Vencord