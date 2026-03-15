import 'dotenv/config';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

const apiKey = process.env.DOUBAO_API_KEY;
const baseUrl = process.env.DOUBAO_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const model = process.env.DOUBAO_MODEL || 'ep-20260315183946-zh65s';
const videoPath = '/Users/bytedance/Downloads/IMG_5962_edited.mp4';

async function testDoubao() {
  console.log('=== Testing Doubao Files API + Responses API ===');
  console.log('API Key:', apiKey ? `${apiKey.slice(0, 10)}...` : 'MISSING');
  console.log('Base URL:', baseUrl);
  console.log('Model:', model);
  console.log('Video:', videoPath);
  console.log('');

  try {
    // Step 1: Upload file
    console.log('Step 1: Uploading file...');
    const formData = new FormData();
    formData.append('purpose', 'user_data');
    formData.append('file', fs.createReadStream(videoPath));
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

    // Step 2: Wait for processing
    console.log('Step 2: Waiting for file processing...');
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

    // Step 3: Analyze video
    console.log('Step 3: Analyzing video...');
    const body = {
      model,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_video',
              file_id: fileId,
            },
            {
              type: 'input_text',
              text: '找出视频中穿白色球衣的球员进球的片段。请返回纯 JSON 格式：{"description": "描述", "events": [{"label": "事件", "start": 0.0, "end": 5.0, "confidence": 0.9}]}',
            },
          ],
        },
      ],
    };

    const analysisResponse = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!analysisResponse.ok) {
      const text = await analysisResponse.text();
      throw new Error(`Analysis failed: ${analysisResponse.status} ${text}`);
    }

    const result = await analysisResponse.json();
    console.log('✅ Analysis complete');
    console.log('');
    console.log('=== Result ===');
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testDoubao();
