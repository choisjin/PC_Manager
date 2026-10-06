# ffmpeg (Windows 에이전트 영상 자르기용)

- `ffmpeg-win64.zip`: FFmpeg 9.0.2 essentials build (gyan.dev, Windows x64, libx264 포함)
  - 원본: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
  - ffmpeg.exe가 105MB라 GitHub 파일 한도(100MB)를 넘어 압축해 둔다 (약 37MB)
- 배포: `build/package.ps1`이 풀어서 서버 패키지 `server/agent/tools/ffmpeg.exe`에 넣는다.
  Windows 에이전트는 PATH에 ffmpeg가 없으면 서버의 `/api/install/tools/ffmpeg.exe`를 한 번 받아
  `C:\ProgramData\PcManager\Agent\tools`에 둔다. (Linux 에이전트는 설치 때 apt로 ffmpeg 설치)
- 라이선스: GPL v3 (zip 안 LICENSE). 소스: https://ffmpeg.org/download.html · 빌드 구성: zip 안 README.txt
- 갱신: 새 essentials zip에서 ffmpeg.exe·LICENSE·README.txt만 골라 같은 이름으로 다시 압축
