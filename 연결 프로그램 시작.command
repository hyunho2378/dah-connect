#!/bin/bash
# DAH Connect 시작 (더블클릭). Node.js 가 있어야 합니다.
cd "$(dirname "$0")" || exit 1
clear
echo "DAH Connect: 내 ChatGPT 요금제를 디인예 워크스페이스 AI 창에서 쓰게 해 주는 프로그램"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 설치되어 있지 않습니다."
  echo "  1) https://nodejs.org 에서 LTS 버전(20 이상)을 내려받아 설치하세요."
  echo "  2) 설치가 끝나면 이 파일을 다시 더블클릭하세요."
  open "https://nodejs.org" 2>/dev/null
  echo
  read -n 1 -s -r -p "아무 키나 누르면 닫습니다."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 20 ]; then
  echo "Node.js 버전이 낮습니다 (지금 $(node -v), 필요 v20 이상)."
  echo "https://nodejs.org 에서 새 버전을 설치한 뒤 다시 실행하세요."
  open "https://nodejs.org" 2>/dev/null
  echo
  read -n 1 -s -r -p "아무 키나 누르면 닫습니다."
  exit 1
fi

node dah-connect.mjs start "$@"
STATUS=$?
echo
if [ $STATUS -ne 0 ]; then
  echo "프로그램이 오류로 끝났습니다 (코드 $STATUS). 위 안내를 확인하세요."
fi
read -n 1 -s -r -p "아무 키나 누르면 이 창을 닫습니다."
