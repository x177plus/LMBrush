/* Rule-based fallback planner.
 *
 * This is not the main path: with an LLM configured, the model writes the plan.
 * The local planner exists so the product still works with no API key and so
 * the renderer can be tested deterministically. It covers common subjects with
 * parametric scenes and gracefully degrades to an abstract composition.
 */

import { normalizePlan } from "./schema.js";

const PALETTES = {
  warm: {
    bg: "#f6ead9", bg2: "#efd9c2", ink: "#3c2a22", skin: "#f2c9a9", skinShade: "#e0a982",
    hair: "#3a2a24", cloth: "#b5563c", accent: "#e0a458", leaf: "#5d7a5a",
    sky: "#e8d9c8", sea: "#7fa8bf", ground: "#d8c3a5", light: "#fff6ec",
  },
  cool: {
    bg: "#e6f0f4", bg2: "#cfe0e8", ink: "#22333d", skin: "#eec3a4", skinShade: "#d8a887",
    hair: "#2b2b31", cloth: "#3d6b7d", accent: "#e8b04b", leaf: "#4f7a6a",
    sky: "#cfe3f2", sea: "#6f9fb8", ground: "#c9d6d2", light: "#f7fbfd",
  },
  night: {
    bg: "#101624", bg2: "#1b2436", ink: "#070a10", skin: "#d9a883", skinShade: "#bd8a68",
    hair: "#161a24", cloth: "#2f4a6b", accent: "#f2d16b", leaf: "#2f4a3a",
    sky: "#101624", sea: "#1f3b52", ground: "#1b2436", light: "#dfe8ff",
  },
  forest: {
    bg: "#e9efe3", bg2: "#cbd9bd", ink: "#263326", skin: "#e7bd9b", skinShade: "#cfa382",
    hair: "#3a2d22", cloth: "#4f6b4a", accent: "#d9a441", leaf: "#3f5f45",
    sky: "#dcebe6", sea: "#6f8f86", ground: "#b9c8a8", light: "#f6f9f1",
  },
  sunset: {
    bg: "#fde3cc", bg2: "#f6b9a0", ink: "#4a2b2b", skin: "#eec0a0", skinShade: "#d49c7d",
    hair: "#33241f", cloth: "#8a4a4a", accent: "#f4c26b", leaf: "#6b6b4a",
    sky: "#f9c9a6", sea: "#9a6d78", ground: "#c98f72", light: "#fff3e6",
  },
  pastel: {
    bg: "#f6ecf3", bg2: "#e3d8ef", ink: "#3a3346", skin: "#f3d2bd", skinShade: "#dcb49c",
    hair: "#5a4a55", cloth: "#8f9bd6", accent: "#f2c879", leaf: "#9bc4a8",
    sky: "#e6dcf2", sea: "#a9c6d8", ground: "#d9cfc4", light: "#fdf9fc",
  },
  mono: {
    bg: "#f2f2f0", bg2: "#dcdcd8", ink: "#1c1c1e", skin: "#d8d3cc", skinShade: "#bab4ab",
    hair: "#2a2a2c", cloth: "#5a5a5e", accent: "#a8a8a4", leaf: "#7a7a76",
    sky: "#e4e4e0", sea: "#b4b4b0", ground: "#c8c8c2", light: "#fbfbf9",
  },
};

export function planFromPrompt(prompt, styleOverride = "auto", variant = 0) {
  const text = String(prompt || "").trim();
  const subject = detectSubject(text);
  const preset = styleOverride && styleOverride !== "auto" ? styleOverride : detectStyle(text);
  const paletteName = pickPalette(text, subject);
  const pal = PALETTES[paletteName];
  const variantKey = Number.isFinite(Number(variant)) ? Math.max(0, Math.round(Number(variant))) : 0;
  const rnd = mulberry32(hashString(`${text}|${preset}|${subject}|${variantKey}`));
  const layers = BUILDERS[subject](pal, rnd, { text, paletteName, subject });

  return normalizePlan({
    version: 1,
    title: titleFor(subject, text),
    canvas: { w: 1000, h: 1000, background: pal.bg },
    style: {
      preset,
      lineWidth: preset === "line" ? 4 : 0,
      outline: preset === "line" ? pal.ink : null,
    },
    layers,
  });
}

/* ------------------------------------------------------------ composition */

function portrait(p, rnd, ctx) {
  const longHair = rnd() > 0.45;
  const hair = [
    path(
      "M350 520 C350 360 430 320 500 320 C570 320 650 360 650 520 C620 420 560 396 500 396 C440 396 380 420 350 520 Z",
      p.hair
    ),
  ];
  if (longHair) {
    hair.push(
      path("M352 500 C330 660 336 760 376 800 C356 680 362 590 388 536 Z", p.hair),
      path("M648 500 C670 660 664 760 624 800 C644 680 638 590 612 536 Z", p.hair)
    );
  }

  const layers = [
    { id: "backdrop", elements: [
      ellipse(500, 470, 340, 340, p.bg2),
      ellipse(180, 820, 90, 90, p.bg2),
      ellipse(840, 190, 60, 60, p.bg2),
    ] },
    { id: "body", elements: [
      path("M240 1000 C255 820 370 760 500 760 C630 760 745 820 760 1000 Z", p.cloth),
      polygon([[440, 760], [500, 840], [560, 760], [530, 742], [500, 782], [470, 742]], p.light),
      rect(462, 640, 76, 130, p.skinShade, 30),
    ] },
    { id: "head", elements: [
      ellipse(352, 540, 26, 40, p.skinShade),
      ellipse(648, 540, 26, 40, p.skinShade),
      ellipse(500, 520, 150, 168, p.skin),
      ...hair,
      ellipse(440, 532, 30, 16, p.light),
      ellipse(560, 532, 30, 16, p.light),
      ellipse(442, 532, 13, 13, p.ink),
      ellipse(558, 532, 13, 13, p.ink),
      ellipse(447, 527, 4, 4, p.light),
      ellipse(563, 527, 4, 4, p.light),
      path("M408 490 Q440 476 472 490", "none", p.hair, 6),
      path("M528 490 Q560 476 592 490", "none", p.hair, 6),
      path("M494 560 Q500 584 514 588", "none", p.skinShade, 5),
      path(
        rnd() > 0.5 ? "M458 620 Q500 650 542 620" : "M462 624 Q500 640 538 624",
        "none",
        p.skinShade,
        7
      ),
      ellipse(408, 590, 22, 12, p.skinShade),
      ellipse(592, 590, 22, 12, p.skinShade),
    ] },
  ];

  if (/(眼镜|glass|spectacles)/i.test(ctx ? ctx.text : "")) {
    layers.push({ id: "glasses", elements: [
      ellipse(440, 532, 46, 34, "none", p.ink, 6),
      ellipse(560, 532, 46, 34, "none", p.ink, 6),
      line(486, 532, 514, 532, p.ink, 6),
      line(394, 528, 372, 520, p.ink, 6),
      line(606, 528, 628, 520, p.ink, 6),
    ] });
  }

  return layers;
}

function cat(p, rnd, ctx) {
  const night = ctx.paletteName === "night";
  const eye = night ? p.accent : "#f2d16b";
  const layers = [
    { id: "sky", elements: night
      ? [
          ellipse(760, 200, 86, 86, p.light),
          ellipse(736, 176, 86, 86, p.bg),
          ...stars(rnd, 8, p.light),
        ]
      : [ellipse(770, 210, 76, 76, p.accent)] },
    { id: "ground", elements: [
      rect(0, 720, 1000, 280, p.ground),
      ellipse(500, 884, 250, 34, p.ink),
    ] },
    { id: "cat", elements: [
      path("M690 812 C842 782 872 646 808 596", "none", p.hair, 34),
      ellipse(500, 760, 200, 150, p.hair),
      ellipse(500, 708, 84, 62, p.light),
      polygon([[352, 574], [318, 392], [462, 480]], p.hair),
      polygon([[648, 574], [682, 392], [538, 480]], p.hair),
      polygon([[362, 548], [342, 440], [430, 492]], p.skin),
      polygon([[638, 548], [658, 440], [570, 492]], p.skin),
      ellipse(500, 520, 152, 142, p.hair),
      ellipse(440, 512, 27, 34, eye),
      ellipse(560, 512, 27, 34, eye),
      ellipse(440, 516, 8, 24, p.ink),
      ellipse(560, 516, 8, 24, p.ink),
      polygon([[486, 582], [514, 582], [500, 598]], p.skinShade),
      path("M500 598 Q480 622 462 612", "none", p.ink, 4),
      path("M500 598 Q520 622 538 612", "none", p.ink, 4),
      line(420, 580, 300, 566, p.light, 3),
      line(420, 596, 300, 610, p.light, 3),
      line(580, 580, 700, 566, p.light, 3),
      line(580, 596, 700, 610, p.light, 3),
      path("M430 404 Q500 372 570 404", "none", p.ink, 8),
    ] },
  ];
  return layers;
}

function dog(p, rnd) {
  return [
    { id: "backdrop", elements: [
      ellipse(500, 470, 350, 350, p.bg2),
      ellipse(820, 180, 70, 70, p.bg2),
    ] },
    { id: "ground", elements: [
      rect(0, 780, 1000, 220, p.ground),
      ellipse(500, 900, 280, 36, p.ink),
    ] },
    { id: "dog", elements: [
      path("M700 800 C820 760 840 660 780 620", "none", p.hair, 30),
      ellipse(500, 770, 190, 140, p.hair),
      ellipse(500, 720, 90, 66, p.light),
      path("M362 470 C300 500 292 610 338 650 C378 676 402 596 396 540 Z", p.hair),
      path("M638 470 C700 500 708 610 662 650 C622 676 598 596 604 540 Z", p.hair),
      ellipse(500, 520, 158, 148, p.hair),
      ellipse(500, 572, 82, 60, p.light),
      ellipse(500, 560, 30, 22, p.ink),
      ellipse(438, 498, 20, 24, p.ink),
      ellipse(562, 498, 20, 24, p.ink),
      ellipse(443, 491, 6, 7, p.light),
      ellipse(567, 491, 6, 7, p.light),
      path("M500 582 Q480 606 458 596", "none", p.ink, 4),
      path("M500 582 Q520 606 542 596", "none", p.ink, 4),
      rect(430, 706, 140, 26, p.cloth, 12),
      ellipse(500, 744, 16, 20, p.accent),
      ellipse(360, 452, 30, 42, p.hair),
      ellipse(640, 452, 30, 42, p.hair),
    ] },
  ];
}

function rabbit(p, rnd) {
  return [
    { id: "backdrop", elements: [
      ellipse(500, 480, 340, 340, p.bg2),
      ellipse(170, 200, 54, 54, p.light),
    ] },
    { id: "ground", elements: [
      rect(0, 800, 1000, 200, p.ground),
      ellipse(500, 900, 240, 32, p.ink),
    ] },
    { id: "rabbit", elements: [
      ellipse(500, 790, 170, 120, p.light),
      ellipse(500, 540, 140, 130, p.light),
      ellipse(456, 386, 34, 110, p.light),
      ellipse(544, 386, 34, 110, p.light),
      ellipse(456, 392, 18, 78, p.skin),
      ellipse(544, 392, 18, 78, p.skin),
      ellipse(448, 532, 18, 22, p.ink),
      ellipse(552, 532, 18, 22, p.ink),
      ellipse(453, 526, 5, 6, p.light),
      ellipse(557, 526, 5, 6, p.light),
      polygon([[488, 586], [512, 586], [500, 600]], p.skinShade),
      path("M500 600 Q484 620 468 612", "none", p.ink, 4),
      path("M500 600 Q516 620 532 612", "none", p.ink, 4),
      ellipse(622, 840, 46, 40, p.light),
      ellipse(408, 610, 22, 12, p.skin),
      ellipse(592, 610, 22, 12, p.skin),
    ] },
  ];
}

function fox(p, rnd) {
  return [
    { id: "sky", elements: [
      ellipse(760, 220, 80, 80, p.accent),
      rect(0, 700, 1000, 300, p.ground),
    ] },
    { id: "fox", elements: [
      path("M690 820 C850 790 900 700 860 640 C930 690 930 800 820 856 Z", p.hair),
      path("M860 640 C890 668 906 724 880 770 C862 726 852 686 860 640 Z", p.light),
      ellipse(500, 760, 180, 140, p.hair),
      polygon([[356, 560], [318, 372], [470, 470]], p.hair),
      polygon([[644, 560], [682, 372], [530, 470]], p.hair),
      polygon([[382, 538], [358, 428], [440, 486]], p.skin),
      polygon([[618, 538], [642, 428], [560, 486]], p.skin),
      ellipse(500, 512, 150, 136, p.hair),
      path("M380 548 C410 624 452 664 500 668 C548 664 590 624 620 548 C570 586 540 598 500 598 C460 598 430 586 380 548 Z", p.light),
      ellipse(440, 508, 20, 24, p.ink),
      ellipse(560, 508, 20, 24, p.ink),
      ellipse(445, 501, 6, 7, p.light),
      ellipse(565, 501, 6, 7, p.light),
      ellipse(500, 604, 24, 18, p.ink),
      ellipse(500, 780, 90, 72, p.light),
    ] },
  ];
}

function bird(p, rnd) {
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 760, p.sky),
      ellipse(220, 210, 110, 32, p.light),
      ellipse(290, 196, 78, 26, p.light),
    ] },
    { id: "branch", elements: [
      rect(0, 780, 1000, 220, p.ground),
      rect(180, 720, 640, 26, "#6b4a33", 13),
      path("M700 746 Q760 790 808 860", "none", "#6b4a33", 20),
    ] },
    { id: "bird", elements: [
      line(470, 720, 470, 756, p.ink, 6),
      line(540, 720, 540, 756, p.ink, 6),
      polygon([[470, 676], [318, 754], [470, 754]], p.hair),
      ellipse(500, 620, 130, 118, p.hair),
      path("M470 600 C520 560 600 590 610 660 C570 700 500 690 470 660 Z", p.accent),
      ellipse(390, 500, 82, 78, p.hair),
      polygon([[316, 500], [232, 522], [318, 548]], p.accent),
      ellipse(408, 486, 16, 18, p.light),
      ellipse(410, 488, 8, 9, p.ink),
      path("M540 668 C580 680 610 686 640 680", "none", p.hair, 10),
    ] },
  ];
}

function fish(p, rnd) {
  return [
    { id: "water", elements: [
      rect(0, 0, 1000, 1000, p.sea),
      rect(0, 800, 1000, 200, p.ground),
      ellipse(180, 180, 16, 18, p.light),
      ellipse(240, 130, 10, 12, p.light),
      ellipse(820, 240, 20, 22, p.light),
      ellipse(760, 300, 8, 9, p.light),
    ] },
    { id: "fish", elements: [
      polygon([[770, 520], [920, 440], [920, 600]], p.accent),
      polygon([[560, 380], [610, 300], [640, 394]], p.accent),
      ellipse(560, 500, 210, 130, p.hair),
      path("M520 616 C560 680 620 690 660 660 C620 620 580 606 520 616 Z", p.accent),
      ellipse(430, 476, 22, 24, p.light),
      ellipse(432, 478, 10, 11, p.ink),
      path("M520 400 C540 460 540 540 520 600", "none", p.light, 6),
      path("M610 410 C626 468 626 532 610 590", "none", p.light, 6),
      ellipse(560, 660, 120, 14, p.light),
    ] },
  ];
}

function bear(p, rnd, ctx) {
  const panda = /熊猫|panda/i.test(ctx ? ctx.text : "");
  const fur = panda ? p.light : p.hair;
  const patch = panda ? p.ink : p.hair;
  return [
    { id: "backdrop", elements: [
      ellipse(500, 480, 350, 350, p.bg2),
      ellipse(820, 190, 64, 64, p.bg2),
    ] },
    { id: "ground", elements: [
      rect(0, 790, 1000, 210, p.ground),
      ellipse(500, 900, 280, 34, p.ink),
    ] },
    { id: "bear", elements: [
      ellipse(500, 780, 200, 140, fur),
      ellipse(360, 430, 62, 62, patch),
      ellipse(640, 430, 62, 62, patch),
      ellipse(500, 520, 170, 158, fur),
      ellipse(440, 500, 46, 54, patch),
      ellipse(560, 500, 46, 54, patch),
      ellipse(440, 508, 16, 20, p.ink),
      ellipse(560, 508, 16, 20, p.ink),
      ellipse(500, 566, 84, 60, panda ? p.ink : p.light),
      ellipse(500, 556, 30, 22, p.ink),
      path("M500 578 Q484 602 466 592", "none", p.ink, 4),
      path("M500 578 Q516 602 534 592", "none", p.ink, 4),
    ] },
  ];
}

function landscape(p, rnd) {
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 700, p.sky),
      ellipse(760, 200, 84, 84, p.accent),
      ellipse(240, 210, 120, 32, p.light),
      ellipse(310, 196, 84, 26, p.light),
      ellipse(700, 300, 90, 24, p.light),
    ] },
    { id: "far", elements: [
      polygon([[0, 640], [230, 350], [430, 640]], p.leaf, 0),
      polygon([[300, 640], [560, 300], [830, 640]], "#8aa5bb"),
      polygon([[640, 640], [840, 420], [1000, 640]], "#a6bccd"),
      polygon([[500, 380], [560, 300], [620, 382]], p.light),
    ] },
    { id: "mid", elements: [
      polygon([[0, 720], [270, 520], [540, 720]], "#5f7d6a"),
      polygon([[420, 720], [700, 500], [1000, 720]], "#4f6b5a"),
    ] },
    { id: "near", elements: [
      rect(0, 680, 1000, 320, p.ground),
      path("M0 760 C220 720 340 800 520 780 C700 760 820 820 1000 780 L1000 1000 L0 1000 Z", "#9fb6a6"),
      path("M420 1000 C470 880 500 800 560 740 L620 760 C560 830 540 910 520 1000 Z", p.sea),
    ] },
    { id: "trees", elements: [
      rect(170, 640, 16, 70, "#3a2d24"),
      polygon([[178, 540], [126, 652], [230, 652]], p.leaf),
      rect(820, 604, 18, 96, "#3a2d24"),
      polygon([[829, 486], [760, 630], [898, 630]], p.leaf),
      rect(700, 676, 12, 56, "#3a2d24"),
      polygon([[706, 610], [664, 690], [748, 690]], p.leaf),
    ] },
  ];
}

function sea(p, rnd) {
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 560, p.sky),
      ellipse(720, 190, 76, 76, p.accent),
      ellipse(250, 220, 110, 28, p.light),
      ellipse(310, 208, 70, 22, p.light),
      path("M180 320 Q210 300 240 320 Q270 340 300 320", "none", p.ink, 5),
      path("M620 280 Q650 260 680 280 Q710 300 740 280", "none", p.ink, 5),
    ] },
    { id: "sea", elements: [
      rect(0, 560, 1000, 440, p.sea),
      rect(0, 560, 1000, 10, p.light),
      path("M0 650 Q120 630 240 650 T480 650 T720 650 T960 650", "none", p.light, 6),
      path("M0 740 Q140 718 280 740 T560 740 T840 740 T1000 740", "none", p.light, 6),
      path("M0 840 Q160 818 320 840 T640 840 T960 840", "none", p.light, 6),
    ] },
    { id: "boat", elements: [
      line(500, 560, 500, 330, p.ink, 8),
      polygon([[510, 350], [510, 540], [660, 540]], p.light),
      polygon([[490, 380], [490, 540], [370, 540]], p.cloth),
      polygon([[360, 552], [680, 552], [620, 620], [420, 620]], p.ink),
      path("M420 620 Q500 642 620 620", "none", p.light, 4),
    ] },
  ];
}

function forest(p, rnd) {
  const trees = [
    [180, 700, 60, 150, 120],
    [360, 660, 46, 120, 150],
    [640, 690, 54, 140, 130],
    [820, 650, 40, 110, 150],
  ];
  const treeEls = [];
  for (const [x, base, trunkW, trunkH, r] of trees) {
    treeEls.push(rect(x - trunkW / 2, base - trunkH, trunkW, trunkH, "#4a3526"));
    treeEls.push(
      ellipse(x, base - trunkH - r * 0.7, r, r * 0.9, p.leaf),
      ellipse(x - r * 0.6, base - trunkH - r * 0.3, r * 0.7, r * 0.7, p.leaf),
      ellipse(x + r * 0.6, base - trunkH - r * 0.25, r * 0.75, r * 0.7, p.leaf)
    );
  }
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 720, p.sky),
      ellipse(760, 180, 70, 70, p.accent),
      ellipse(250, 190, 110, 30, p.light),
    ] },
    { id: "ground", elements: [
      rect(0, 700, 1000, 300, p.ground),
      path("M380 1000 C420 880 470 820 540 780 L600 800 C520 850 480 920 460 1000 Z", p.bg2),
    ] },
    { id: "trees", elements: treeEls },
    { id: "bushes", elements: [
      ellipse(280, 760, 70, 40, p.leaf),
      ellipse(740, 770, 84, 44, p.leaf),
      ellipse(520, 800, 56, 30, p.leaf),
    ] },
  ];
}

function city(p, rnd) {
  const buildings = [
    [60, 560, 120, 300],
    [200, 470, 150, 390],
    [370, 610, 110, 250],
    [500, 400, 170, 460],
    [690, 520, 130, 340],
    [840, 600, 130, 260],
  ];
  const els = [];
  for (const [x, y, w, h] of buildings) {
    els.push(rect(x, y, w, h, p.ink));
    let windows = 0;
    outer: for (let wy = y + 24; wy < y + h - 24; wy += 46) {
      for (let wx = x + 16; wx < x + w - 20; wx += 38) {
        if (windows >= 6) break outer;
        els.push(rect(wx, wy, 16, 22, p.accent, 3));
        windows++;
      }
    }
  }
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 700, p.sky),
      ellipse(790, 170, 64, 64, p.accent),
      ellipse(230, 190, 100, 26, p.light),
    ] },
    { id: "skyline", elements: els },
    { id: "ground", elements: [
      rect(0, 860, 1000, 140, p.ground),
      rect(0, 880, 1000, 60, p.ink),
      line(0, 910, 1000, 910, p.light, 6),
    ] },
  ];
}

function space(p, rnd) {
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 1000, p.bg),
      ...stars(rnd, 22, p.light),
      ellipse(790, 230, 52, 52, p.light),
    ] },
    { id: "planet", elements: [
      ellipse(500, 540, 300, 76, "none", p.accent, 4),
      ellipse(500, 540, 250, 250, p.cloth),
      path("M300 470 C380 420 470 430 520 500 C450 520 380 540 330 610 Z", p.ink, undefined, undefined, 0.25),
      ellipse(430, 470, 42, 34, p.ink, undefined, undefined, 0.25),
      ellipse(590, 620, 26, 22, p.ink, undefined, undefined, 0.25),
    ] },
    { id: "comet", elements: [
      line(760, 700, 620, 840, p.light, 5),
      ellipse(770, 690, 14, 14, p.accent),
    ] },
  ];
}

function flower(p, rnd) {
  const stems = [
    [300, 800, 300, 560],
    [500, 820, 500, 500],
    [700, 810, 700, 590],
  ];
  const els = [];
  stems.forEach(([x1, y1, x2, y2], i) => {
    els.push(line(x1, y1, x2, y2, p.leaf, 10));
    els.push(ellipse(x2 - 34, (y1 + y2) / 2, 34, 16, p.leaf));
    els.push(ellipse(x2 + 34, (y1 + y2) / 2 + 20, 30, 14, p.leaf));
    const cx = x2;
    const cy = y2 - 30;
    const count = 6;
    const radius = 46 + i * 4;
    for (let k = 0; k < count; k++) {
      const angle = (Math.PI * 2 * k) / count;
      els.push(
        ellipse(
          cx + Math.cos(angle) * radius,
          cy + Math.sin(angle) * radius,
          32,
          22,
          p.accent
        )
      );
    }
    els.push(ellipse(cx, cy, 26, 26, p.cloth));
    els.push(ellipse(cx - 6, cy - 6, 8, 8, p.light));
  });
  return [
    { id: "sky", elements: [
      rect(0, 0, 1000, 720, p.sky),
      ellipse(780, 180, 70, 70, p.accent),
      ellipse(220, 220, 110, 30, p.light),
    ] },
    { id: "ground", elements: [
      rect(0, 760, 1000, 240, p.ground),
    ] },
    { id: "flowers", elements: els },
  ];
}

function abstractScene(p, rnd) {
  const els = [ellipse(500, 500, 320, 320, p.bg2)];
  const shapes = 7;
  for (let i = 0; i < shapes; i++) {
    const cx = 220 + rnd() * 560;
    const cy = 220 + rnd() * 560;
    const r = 40 + rnd() * 120;
    if (rnd() > 0.5) {
      els.push(ellipse(cx, cy, r, r, i % 2 ? p.accent : p.cloth));
    } else {
      els.push(polygon([
        [cx, cy - r],
        [cx + r * 0.87, cy + r * 0.5],
        [cx - r * 0.87, cy + r * 0.5],
      ], i % 2 ? p.leaf : p.hair));
    }
  }
  return [
    { id: "backdrop", elements: [rect(0, 0, 1000, 1000, p.bg)] },
    { id: "shapes", elements: els },
  ];
}

const BUILDERS = {
  portrait, cat, dog, rabbit, fox, bird, fish, bear, landscape, sea, forest, city, space, flower, abstract: abstractScene,
};

/* ----------------------------------------------------------------- helpers */

function rect(x, y, w, h, fill, rx) {
  return { type: "rect", x, y, w, h, fill, ...(rx ? { rx } : {}) };
}

function ellipse(cx, cy, rx, ry, fill, stroke, strokeWidth, opacity) {
  return {
    type: "ellipse", cx, cy, rx, ry, fill,
    ...(stroke ? { stroke, strokeWidth } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

function polygon(points, fill) {
  return { type: "polygon", points, fill };
}

function path(d, fill, stroke, strokeWidth, opacity) {
  return {
    type: "path", d, fill,
    ...(stroke ? { stroke, strokeWidth } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
  };
}

function line(x1, y1, x2, y2, stroke, strokeWidth) {
  return { type: "line", x1, y1, x2, y2, stroke, strokeWidth };
}

function stars(rnd, count, color) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(ellipse(rnd() * 1000, rnd() * 620, 2 + rnd() * 3, 2 + rnd() * 3, color));
  }
  return out;
}

function detectSubject(text) {
  if (/(头像|肖像|人像|自画像|女孩|男孩|女性|男性|少女|少年|portrait|avatar|face|person)/i.test(text)) return "portrait";
  if (/(熊猫|panda)/i.test(text)) return "bear";
  if (/(猫头鹰|owl)/i.test(text)) return "bird";
  if (/(猫|cat|kitten)/i.test(text)) return "cat";
  if (/(狗|犬|dog|puppy)/i.test(text)) return "dog";
  if (/(兔|rabbit|bunny)/i.test(text)) return "rabbit";
  if (/(狐|fox)/i.test(text)) return "fox";
  if (/(鸟|bird|雀|owl)/i.test(text)) return "bird";
  if (/(鱼|fish)/i.test(text)) return "fish";
  if (/(熊|bear)/i.test(text)) return "bear";
  if (/(星系|星空|宇宙|银河|space|galaxy|planet|星球)/i.test(text)) return "space";
  if (/(城市|都市|city|skyline|建筑|楼)/i.test(text)) return "city";
  if (/(海|ocean|sea|beach|海滩|海边|沙滩)/i.test(text)) return "sea";
  if (/(山|mountain|风景|landscape|景色|自然|山谷|远山)/i.test(text)) return "landscape";
  if (/(森林|树林|forest|woods|树)/i.test(text)) return "forest";
  if (/(花|flower|植物|plant)/i.test(text)) return "flower";
  return "abstract";
}

function pickPalette(text, subject) {
  if (/(夜|星空|宇宙|银河|space|galaxy|night|黑猫)/i.test(text)) return "night";
  if (/(日落|夕阳|黄昏|sunset)/i.test(text)) return "sunset";
  if (/(森林|树|forest|woods)/i.test(text)) return "forest";
  if (/(海|ocean|sea|beach|蓝|blue|冷色)/i.test(text)) return "cool";
  if (/(粉|pastel|柔和|可爱|梦幻)/i.test(text)) return "pastel";
  if (/(黑白|单色|mono|极简)/i.test(text)) return "mono";
  if (subject === "space") return "night";
  return "warm";
}

function detectStyle(text) {
  if (/(线稿|线描|描边|勾线|outline|line art)/i.test(text)) return "line";
  if (/(渐变|gradient|光晕|氛围光|柔和光)/i.test(text)) return "gradient";
  if (/(极简|minimal|简洁)/i.test(text)) return "minimal";
  return "flat";
}

function titleFor(subject, text) {
  const names = {
    portrait: "肖像", cat: "猫", dog: "狗", rabbit: "兔", fox: "狐狸", bird: "鸟",
    fish: "鱼", bear: "熊", landscape: "风景", sea: "海", forest: "森林",
    city: "城市", space: "星空", flower: "花", abstract: "抽象构成",
  };
  const cleaned = text.replace(/\s+/g, "").slice(0, 24);
  return `${names[subject] || "插画"} · ${cleaned || "未命名"}`;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}