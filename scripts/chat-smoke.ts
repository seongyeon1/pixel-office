import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeChatResponder } from '../src/server/adapters/chat.js';
const cwd = await mkdtemp(join(tmpdir(), 'pixel-qa-smoke-'));
try {
  for (const provider of ['codex', 'claude'] as const) {
    let text = '',
      model = '';
    await createNativeChatResponder(cwd)(
      {
        provider,
        signal: AbortSignal.timeout(90000),
        prompt:
          '당신은 작업 기록 설명 도우미입니다. 제공된 기록만 참고하고 도구를 사용하지 마세요. 기록: 10:20에 fixture-hello.ts 파일을 읽었으며 테스트는 아직 실행하지 않았습니다. 질문: 어떤 파일을 읽었고 테스트는 했나요? 한국어 두 문장으로 답하세요.',
      },
      (value, m) => {
        text = value;
        model = m ?? model;
      },
    );
    if (!text.includes('fixture-hello.ts') || !text.includes('테스트'))
      throw new Error(`${provider} evidence missing`);
    console.log(JSON.stringify({ provider, model, text, files: await readdir(cwd) }));
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
