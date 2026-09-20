import type { SemanticPolicy } from "../src/contract";
export const policy: SemanticPolicy = {
  instructions:
    "Find synthetic passwords and confidential business information.",
  categories: [
    {
      id: "credential",
      reasons: ["embedded_password", "embedded_access_token"],
      inclusion: [],
      exclusion: [],
      examples: [],
    },
  ],
};
