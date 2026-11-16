#!/usr/bin/env bash
# SSM /hanaeum-mvp/{env}/* 를 export 문으로 출력한다. 사용: eval "$(apps/api/scripts/ssm-env.sh dev)"
set -euo pipefail
aws ssm get-parameters-by-path --path "/hanaeum-mvp/${1:?env}/" --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text | while IFS=$'\t' read -r n v; do printf 'export %s=%q\n' "${n##*/}" "$v"; done
