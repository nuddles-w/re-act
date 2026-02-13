import { parseFeatures } from "../utils/parseFeatures.js";

const mockResponse = `
{
  "segments": [
    {
      "start": "00:00:15",
      "end": "00:00:20",
      "energy": 0.8,
      "label": "捣碎鸡蛋"
    }
  ],
  "events": [
    {
      "label": "开始捣碎",
      "start": 15.5,
      "end": 19.5,
      "confidence": 0.95
    }
  ]
}
`;

const result = parseFeatures(mockResponse);
console.log(JSON.stringify(result, null, 2));
