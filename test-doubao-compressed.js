import 'dotenv/config';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { compressVideoForUpload } from './server/utils/compressVideo.js';

const apiKey = process.env.DOUBAO_API_KEY;
const baseUrl = process.env.DOUBAO_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const model = process.env.DOUBAO_MODEL || 'ep-20260315183946-zh65s';
const videoPath = '/Users/bytedance/Downloads/IMG_5962_edited.mp4';

async function testDoubaoWithCompression() {
  console.log('=== Testing Doubao with Compressed Video ===');
  console.log('API Key:', apiKey ? `${apiKey.slice(0, 10)}...` : 'MISSING');
  console.log('Base URL:', baseUrl);
  console.log('Model:', model);
  console.log('Video:', videoPath);
  console.log('');

  try {
    // Step 1: Compress video (same as production)
    console.log('Step 1: Compressing video...');
    const compressedPath = videoPath.replace(/\.[^.]+$/, '') + '-test-compressed.mp4';
    const profile = { maxWidth: 1280, maxHeight: 720, fps: 3, audioBitrate: '64k' };
    await compressVideoForUpload(videoPath, compressedPath, profile);
    console.log('✅ Compression complete');
    console.log('');

    // Step 2: Upload compressed file
    console.log('Step 2: Uploading compressed file...');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(compressedPath));
    formData.append('purpose', 'user_data');
    formData.append('preprocess_configs[video][fps]', '3');

    console.log('FormData fields:', {
      purpose: 'user_data',
      fps: '3',
      file: compressedPath,
    });

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

    // Cleanup
    if (fs.existsSync(compressedPath)) {
      fs.unlinkSync(compressedPath);
      console.log('✅ Cleaned up compressed file');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testDoubaoWithCompression();
