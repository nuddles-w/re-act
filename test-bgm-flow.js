import 'dotenv/config';
import fetch from 'node-fetch';

const apiBase = 'http://localhost:8787';

async function testBGMFlow() {
  console.log('=== Testing BGM Flow ===\n');

  try {
    // Step 1: 模拟添加 BGM 的请求
    console.log('Step 1: Simulating BGM request...');
    const analyzeResponse = await fetch(`${apiBase}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration: 5,
        request: '添加一个很燃的背景音乐',
        pe: '测试',
        engine: 'auto',
      }),
    });

    if (!analyzeResponse.ok) {
      throw new Error(`Analyze failed: ${analyzeResponse.status}`);
    }

    // 等待 SSE 响应
    const reader = analyzeResponse.body;
    let sessionId = null;
    let draftReceived = false;

    for await (const chunk of reader) {
      const text = chunk.toString();
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          console.log('Received event:', data.type);

          if (data.type === 'result') {
            sessionId = data.data.sessionId;
            console.log('Session ID:', sessionId);
          }

          if (data.type === 'result' || data.type === 'complete') {
            draftReceived = true;
            break;
          }
        }
      }

      if (draftReceived) break;
    }

    if (!sessionId) {
      throw new Error('No session ID received');
    }

    console.log('\nStep 2: Fetching Draft...');
    const draftResponse = await fetch(`${apiBase}/api/draft/${sessionId}`);
    const draftData = await draftResponse.json();

    if (!draftData.success) {
      throw new Error('Failed to fetch draft');
    }

    console.log('Draft received:', JSON.stringify(draftData.draft, null, 2));

    // Step 3: 检查音频轨道
    console.log('\nStep 3: Checking audio track...');
    const audioTrack = draftData.draft.tracks?.find(t => t.type === 'audio');

    if (!audioTrack) {
      console.error('❌ No audio track found!');
      return;
    }

    console.log('✅ Audio track found:', audioTrack.id);
    console.log('   Segments:', audioTrack.segments.length);

    const audioSegment = audioTrack.segments[0];
    console.log('   Source file:', audioSegment.sourceFile);
    console.log('   Volume:', audioSegment.volume);
    console.log('   Metadata:', audioSegment.metadata);

    // Step 4: 测试音频文件访问
    console.log('\nStep 4: Testing audio file access...');
    const audioUrl = `${apiBase}/api/audio/${encodeURIComponent(audioSegment.sourceFile)}`;
    console.log('   URL:', audioUrl);

    const audioResponse = await fetch(audioUrl);
    console.log('   Status:', audioResponse.status, audioResponse.statusText);

    if (audioResponse.ok) {
      const contentType = audioResponse.headers.get('content-type');
      const contentLength = audioResponse.headers.get('content-length');
      console.log('   Content-Type:', contentType);
      console.log('   Content-Length:', contentLength, 'bytes');
      console.log('✅ Audio file accessible!');
    } else {
      console.error('❌ Audio file not accessible!');
      const errorText = await audioResponse.text();
      console.error('   Error:', errorText);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

testBGMFlow();
