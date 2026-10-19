const roleFamilies = [
  {
    family: "product_design",
    patterns: [
      /product designer/i,
      /product design/i,
      /ux designer/i,
      /ux\s*\/?\s*ui designer/i,
      /ui\s*\/?\s*ux designer/i,
      /ui designer/i,
      /user experience designer/i,
      /user interface designer/i,
      /founding designer/i,
      /first designer/i,
      /design lead/i,
      /interaction designer/i,
      /visual designer/i,
      /product design intern/i
    ],
    signals: [/figma/i, /design system/i, /prototyp/i, /user research/i, /usability/i, /product discovery/i]
  },
  {
    family: "design_engineering",
    patterns: [
      /design engineer/i,
      /design technologist/i,
      /creative technologist/i,
      /frontend designer/i,
      /design systems engineer/i,
      /design engineer,? (?:product|frontend)/i,
      /designer.*engineer/i,
      /engineer.*design/i
    ],
    signals: [/design system/i, /component librar/i, /prototyp/i, /css/i, /react/i, /interaction/i]
  },
  {
    family: "frontend_engineering",
    patterns: [
      /frontend developer/i,
      /front[- ]end engineer/i,
      /frontend engineer/i,
      /web developer/i,
      /ui engineer/i,
      /front-end developer/i,
      /frontend software engineer/i,
      /software engineer.*frontend/i,
      /software engineer.*front[- ]end/i
    ],
    signals: [/react/i, /typescript/i, /javascript/i, /css/i, /html/i, /next\.js/i]
  },
  {
    family: "product_engineering",
    patterns: [
      /product engineer/i,
      /founding engineer/i,
      /founding software engineer/i,
      /full[- ]stack developer/i,
      /full[- ]stack engineer/i,
      /software engineer/i
    ],
    signals: [/ship features/i, /product-minded/i, /customer-facing/i, /react/i, /typescript/i, /node\.js/i]
  }
];

export function matchRole(title = "", description = "") {
  const titleText = title.trim();
  const body = description.slice(0, 12000);
  const families = [];
  let score = 0;

  for (const role of roleFamilies) {
    const titleMatch = role.patterns.some(pattern => pattern.test(titleText));
    const signalCount = role.signals.filter(pattern => pattern.test(body)).length;

    if (titleMatch) {
      families.push(role.family);
      score = Math.max(score, Math.min(100, 65 + signalCount * 5));
    } else if (signalCount >= 3 && /(designer|design|engineer|developer|technologist)/i.test(titleText)) {
      families.push(role.family);
      score = Math.max(score, Math.min(75, 35 + signalCount * 8));
    }
  }

  return {
    matched: families.length > 0,
    families: [...new Set(families)],
    score
  };
}
