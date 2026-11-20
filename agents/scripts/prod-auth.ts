// prod 측정용 데모 계정 토큰. 인증 정보는 secret에서 읽어 권한 600 임시 파일(--cli-input-json)로만 넘기고 바로 지운다 (명령 인자·로그에 남기지 않음)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const aws = (args: string[]) => execFileSync('aws', [...args, '--output', 'text'], { encoding: 'utf8' }).trim();

export function prodToken(name: 'user' | 'admin'): string {
  const client = aws(['ssm', 'get-parameter', '--name', '/hanaeum-mvp/prod/COGNITO_CLIENT_ID', '--query', 'Parameter.Value']);
  const users = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', 'hanaeum-mvp/demo-users', '--query', 'SecretString']));
  const u = users[name];
  const dir = mkdtempSync(join(tmpdir(), 'hanaeum-auth-'));
  const f = join(dir, 'req.json');
  try {
    writeFileSync(f, JSON.stringify({ ClientId: client, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: name, PASSWORD: typeof u === 'string' ? u : u.password } }), { mode: 0o600 });
    return aws(['cognito-idp', 'initiate-auth', '--cli-input-json', `file://${f}`, '--query', 'AuthenticationResult.AccessToken']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
