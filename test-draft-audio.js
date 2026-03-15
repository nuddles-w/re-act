import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

const apiBase = 'http://localhost:8787';
const sessionId = 'sess-1773587208665-g4glj2l'; // 从之前的日志中获取

async function testDraftAndAudio() {
  console.log('=== Testing Draft and Audio Access ===\n');

  try {
    // Step 1: 获取 Draft
    console.log('Step 1: Fetching Draft...');
    const draftResponse = await fetch(`${apiBase}/api/draft/${sessionId}`);
    const draftData = await draftResponse.json();

    if (!draftData.success) {
      throw new Error('Failed to fetch draft');
    }

    console.log('✅ Draft fetched successfully');
    console.log('   Tracks:', draftData.draft.tracks.length);

    // Step 2: 检查音频轨道
    console.log('\nStep 2: Checking audio track...');
    const audioTrack = draftData.draft.tracks?.find(t => t.type === 'audio');

    if (!audioTrack) {
      console.error('❌ No audio track found!');
      console.log('Available tracks:', draftData.draft.tracks.map(t => ({ id: t.id, type: t.type })));
      return;
    }

    console.log('✅ Audio track found:', audioTrack.id);
    console.log('   Segments:', audioTrack.segments.length);

    if (audioTrack.segments.length === 0) {
      console.error('❌ No audio segments!');
      return;
    }

    const audioSegment = audioTrack.segments[0];
    console.log('\nAudio Segment Details:');
    console.log('   Type:', audioSegment.type);
    console.log('   Source file:', audioSegment.sourceFile);
    console.log('   Timeline start:', audioSegment.timelineStart);
    console.log('   Timeline duration:', audioSegment.timelineDuration);
    console.log('   Volume:', audioSegment.volume);
    console.log('   Metadata:', audioSegment.metadata);

    // Step 3: 检查文件是否存在
    console.log('\nStep 3: Checking if file exists locally...');
    if (fs.existsSync(audioSegment.sourceFile)) {
      const stats = fs.statSync(audioSegment.sourceFile);
      console.log('✅ File exists!');
      console.log('   Size:', (stats.size / 1024).toFixed(2), 'KB');
    } else {
      console.error('❌ File does not exist:', audioSegment.sourceFile);
      return;
    }

    // Step 4: 测试 API 访问
    console.log('\nStep 4: Testing API access...');
    const audioUrl = `${apiBase}/api/audio/${encodeURIComponent(audioSegment.sourceFile)}`;
    console.log('   URL:', audioUrl);

    const audioResponse = await fetch(audioUrl);
    console.log('   Status:', audioResponse.status, audioResponse.statusText);

    if (audioResponse.ok) {
      const contentType = audioResponse.headers.get('content-type');
      const contentLength = audioResponse.headers.get('content-length');
      console.log('   Content-Type:', contentType);
      console.log('   Content-Length:', contentLength, 'bytes');
      console.log('✅ Audio file accessible via API!');
    } else {
      console.error('❌ Audio file not accessible via API!');
      const errorText = await audioResponse.text();
      console.error('   Error:', errorText);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

testDraftAndAudio();
