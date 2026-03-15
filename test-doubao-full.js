import 'dotenv/config';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { compressVideoForUpload } from './server/utils/compressVideo.js';
import { analyzeDoubaoVideoContent } from './server/providers/doubaoSeedProvider.js';

const apiKey = process.env.DOUBAO_API_KEY;
const baseUrl = process.env.DOUBAO_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const videoPath = '/Users/bytedance/Downloads/IMG_5962_edited.mp4';

async function testFullDoubaoFlow() {
  console.log('=== Testing Full Doubao Flow (Compress + Upload + Analyze) ===');
  console.log('');

  try {
    // Step 1: Compress
    console.log('Step 1: Compressing video...');
    const compressedPath = videoPath.replace(/\.[^.]+$/, '') + '-full-test-compressed.mp4';
    const profile = { maxWidth: 1280, maxHeight: 720, fps: 3, audioBitrate: '64k' };
    await compressVideoForUpload(videoPath, compressedPath, profile);
    console.log('✅ Compression complete');
    console.log('');

    // Step 2: Upload
    console.log('Step 2: Uploading to Doubao...');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(compressedPath));
    formData.append('purpose', 'user_data');
    formData.append('preprocess_configs[video][fps]', '3');

    const uploadResponse = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} ${text}`);
    }

    const fileInfo = await uploadResponse.json();
    console.log('✅ File uploaded:', fileInfo.id);
    console.log('   Status:', fileInfo.status);
    console.log('');

    // Step 3: Wait for processing
    console.log('Step 3: Waiting for file processing...');
    let fileStatus = fileInfo.status;
    let fileId = fileInfo.id;
    let attempts = 0;

    while (fileStatus === 'processing' && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;

      const statusResponse = await fetch(`${baseUrl}/files/${fileId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        fileStatus = statusData.status;
        console.log(`   Attempt ${attempts}: ${fileStatus}`);
      }
    }

    if (fileStatus !== 'processed' && fileStatus !== 'active') {
      throw new Error(`File processing failed or timeout. Status: ${fileStatus}`);
    }

    console.log('✅ File processed (status: ' + fileStatus + ')');
    console.log('');

    // Step 4: Analyze
    console.log('Step 4: Analyzing video content...');
    const result = await analyzeDoubaoVideoContent({
      fileId,
      fps: 3,
      query: '找出视频中穿白色球衣的球员进球的片段',
      duration: 32.002,
    });

    console.log('');
    console.log('=== Analysis Result ===');
    console.log('Description:', result.description);
    console.log('Events:', result.events.length);
    result.events.forEach((event, i) => {
      console.log(`  ${i + 1}. ${event.label} (${event.start}s - ${event.end}s, confidence: ${event.confidence})`);
    });

    // Cleanup
    if (fs.existsSync(compressedPath)) {
      fs.unlinkSync(compressedPath);
      console.log('');
      console.log('✅ Cleaned up compressed file');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testFullDoubaoFlow();
