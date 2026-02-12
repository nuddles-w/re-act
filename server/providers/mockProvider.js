import { buildMockFeatures } from "../utils/mockFeatures.js";

export const analyzeWithMock = async ({ video, duration, request, pe }) => {
  const debugTimeline = [
    {
      time: new Date().toISOString(),
      role: "system",
      level: "warn",
      message: "使用本地模拟特征",
      data: { name: video.name, duration, pe, request },
    },
  ];
  const features = buildMockFeatures(
    video,
    duration,
    "",
    null,
    `${pe ? `角色：${pe} ` : ""}${request}`
  );
  return {
    source: "mock",
    features,
    summary: {
      highlights: ["使用本地模拟特征"],
      tags: ["mock"],
    },
    debugTimeline,
  };
};
