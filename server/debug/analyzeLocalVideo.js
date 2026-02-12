import fs from "fs/promises";
import path from "path";

const filePath =
  process.argv[2] ||
  "/Users/bytedance/Downloads/1E2C715E-421C-4E90-9929-83902DBC8ED7.mov";
const apiBase = process.env.VITE_API_BASE_URL || "http://localhost:8787";

const run = async () => {
  const buffer = await fs.readFile(filePath);
  const formData = new FormData();
  formData.append(
    "video",
    new File([buffer], path.basename(filePath), { type: "video/quicktime" })
  );
  formData.append("duration", "0");
  formData.append("intent", JSON.stringify({}));
  formData.append(
    "prompt",
    "请分析该视频并仅输出JSON块，字段包含：segments: [{start, end, energy}], events: [{label, start, end, confidence}]。重点标注：鸡蛋被捣碎的起止时间。"
  );
  formData.append(
    "request",
    "识别视频内鸡蛋被捣碎的时间起止点，并输出为事件。"
  );
  formData.append("pe", "剪辑产品经理（PE）");

  const response = await fetch(`${apiBase}/api/analyze`, {
    method: "POST",
    body: formData,
  });
  const payload = await response.json();
  console.log(
    JSON.stringify(
      {
        status: response.status,
        ok: response.ok,
        payload,
      },
      null,
      2
    )
  );
};

run();
