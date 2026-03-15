import "dotenv/config";
import { searchAndDownloadBgm } from "../utils/fetchBgm.js";
import fs from "fs";

/**
 * 测试背景音乐搜索和下载功能
 */
async function testBgm() {
  console.log("=== 测试背景音乐功能 ===\n");

  // 检查 API Key
  if (!process.env.JAMENDO_CLIENT_ID) {
    console.error("❌ 未配置 JAMENDO_CLIENT_ID");
    console.log("请在 .env 中添加：");
    console.log("JAMENDO_CLIENT_ID=your_client_id");
    console.log("\n免费注册：https://devportal.jamendo.com");
    process.exit(1);
  }

  console.log("✅ JAMENDO_CLIENT_ID 已配置\n");

  // 测试搜索
  const testCases = [
    { keywords: "energetic sports highlight", desc: "激昂运动" },
    { keywords: "calm piano", desc: "平静钢琴" },
    { keywords: "upbeat pop", desc: "欢快流行" },
  ];

  for (const { keywords, desc } of testCases) {
    try {
      console.log(`🔍 搜索: ${desc} (${keywords})`);
      const bgm = await searchAndDownloadBgm(keywords, `test-${Date.now()}`);
      console.log(`✅ 找到: ${bgm.title} - ${bgm.artist}`);
      console.log(`   时长: ${bgm.duration}s`);
      console.log(`   文件: ${bgm.path}`);

      // 验证文件存在
      const exists = fs.existsSync(bgm.path);
      const size = exists ? fs.statSync(bgm.path).size : 0;
      console.log(`   大小: ${(size / 1024 / 1024).toFixed(2)} MB`);

      // 清理临时文件
      if (exists) fs.unlinkSync(bgm.path);
      console.log(`   ✅ 测试通过\n`);
    } catch (error) {
      console.error(`❌ 失败: ${error.message}\n`);
    }
  }

  console.log("=== 测试完成 ===");
}

testBgm().catch(console.error);
