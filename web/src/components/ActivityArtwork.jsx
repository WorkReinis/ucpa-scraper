const SKIING_PATH = "M416 56a56 56 0 1 1 112 0 56 56 0 1 1-112 0zM2.7 300.9c6.1-11.8 20.6-16.3 32.4-10.2l197.8 102.7 62.3-87.2-82-92.2c-11-12.4-16.2-27.5-16.2-42.4l111.6 53.4 42.9 48.2c14.9 16.7 16.2 41.6 3.2 59.8l-64.4 90.2 128.3 66.6c13.6 7.1 29.8 7.2 43.6.3l15.2-7.6c11.9-5.9 26.3-1.1 32.2 10.7s1.1 26.3-10.7 32.2l-15.2 7.6c-27.5 13.7-59.9 13.5-87.2-.7L12.9 333.3C1.2 327.2-3.4 312.7 2.7 300.9zM103 49.6l18 8.7 8.7-17.4c4-7.9 13.6-11.1 21.5-7.2s11.1 13.6 7.2 21.5l-8.5 17 84.8 41 .4-.2 76.1-33.8c31.3-13.9 67.9-.7 83.2 29.9l28.9 57.8 68.7 27.5c16.4 6.6 24.4 25.2 17.8 41.6s-25.2 24.4-41.6 17.8L393.8 224c-10.9-4.4-19.8-12.6-25.1-23.1l-11.5-23.1c-16.4 9.4-25.9 14.8-28.5 16.3l-7.6-3.7-185.6-89.6-9.2 18.3c-4 7.9-13.6 11.1-21.5 7.2s-11.1-13.6-7.2-21.5l9-17.9-17.6-8.5C81.1 74.6 77.8 65 81.6 57S95 45.7 103 49.6z";
const SNOWBOARDING_PATH = "M424.5 16a56 56 0 1 1 0 112 56 56 0 1 1 0-112zM166.4 45.5c10.2-14.4 30.2-17.9 44.6-7.7l272 192c14.4 10.2 17.9 30.2 7.7 44.6s-30.2 17.9-44.6 7.7l-92.2-65.1-62.2 53.3 32.1 26.7c18.2 15.2 28.8 37.7 28.8 61.5v87.8l77.5 15.2c6.2 1.2 12.6.9 18.7-.8l41.2-11.8c12.7-3.6 26 3.7 29.7 16.5s-3.7 26-16.5 29.7l-41.2 11.8c-13.4 3.8-27.4 4.4-41.1 1.8L87.1 443.3c-17.2-3.4-33-11.8-45.3-24.1L15.5 393c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l26.2 26.2c5.6 5.6 12.8 9.4 20.6 11l64.2 12.6V285.2c0-27.7 12-54 32.8-72.2l69-60.4-88.2-62.3C159.6 80 156.2 60 166.4 45.5zm58.1 375.7 64 12.5v-75.3c0-4.7-2.1-9.3-5.8-12.3l-58.2-48.5v123.6z";
const TOURING_PATH = "M424.8 16a56 56 0 1 1 0 112 56 56 0 1 1 0-112zm99.8 193.7c7.6 15.2 1.9 33.6-12.6 42V432h-32V267.8l-10.1 5c-27.4 13.7-60.7 6.1-79.4-18.2l-19.6-25.5-39.5 68.8 24.8 12.4c29.5 14.7 42.9 49.5 31.1 80.2l-28.2 73.4h149.4c7.9 0 15.6-2.3 22.2-6.7l7.9-5.3c11-7.4 25.9-4.4 33.3 6.7s4.4 25.9-6.7 33.3l-7.9 5.3C543 506.9 526 512 508.6 512H24c-13.3 0-24-10.7-24-24s10.7-24 24-24h88c0-8.2 3.1-16.4 9.4-22.6l74.1-74.1 10.2-35.9c11.3 18.3 27.7 33.8 48.4 44.2l4.8 2.4-1.9 6.8c-3 10.5-8.6 20-16.3 27.7L189.2 464h101.3l37.1-96.4-55.6-27.8c-41.6-20.8-56.7-72.8-32.7-112.7l37.7-62.7-27.7-7.7c-9-2.5-18.1 3.2-20 12.3l-5.9 29.3c-3.1 15.6-17.1 26.3-32.5 25.7l-130 208H23.2l140.6-225c-3.4-6.3-4.6-13.8-3.1-21.3l5.9-29.3c9.1-45.6 55.1-73.8 99.9-61.4l32.5 9c46.7 13 88 40.8 117.6 79.3l24.9 32.3 40.4-20.2c15.8-7.9 35-1.5 42.9 14.3z";

const ART = {
  ski: { label: "SKI", scene: "resort", palette: "ski", sprite: "ski" },
  snowboard: { label: "SNOWBOARD", scene: "resort", palette: "snowboard", sprite: "snowboard" },
  dual: { label: "SKI + BOARD", scene: "resort", palette: "dual", sprite: "dual" },
  offPisteSki: { label: "OFF-PISTE SKI", scene: "glade", palette: "off-piste-ski", sprite: "ski" },
  offPisteSnowboard: { label: "OFF-PISTE BOARD", scene: "glade", palette: "off-piste-board", sprite: "snowboard" },
  touring: { label: "SKI TOURING", scene: "alpine", palette: "touring", sprite: "touring" },
  splitboard: { label: "SPLITBOARD", scene: "ridge", palette: "splitboard", sprite: "snowboard" },
};

function activityArtworkKind(d) {
  const groups = d.activity_groups ?? [];
  const text = `${d.activity ?? ""} ${d.title ?? ""}`.toLowerCase();
  if (groups.includes("Off-piste snowboard") || /off-piste snowboard/.test(text)) return "offPisteSnowboard";
  if (groups.includes("Off-piste ski") || /off-piste ski/.test(text)) return "offPisteSki";
  if (groups.includes("Splitboard") || /splitboard/.test(text)) return "splitboard";
  if (groups.includes("Ski touring") || /ski touring/.test(text)) return "touring";
  if (groups.includes("Ski") && groups.includes("Snowboard")) return "dual";
  if (groups.includes("Snowboard") || /snowboard/.test(text)) return "snowboard";
  return "ski";
}

function ResortScene() {
  return <>
    <path className="activity-art-mountain" d="M-8 111 28 57l17 21 22-39 78 87H-8Z" />
    <path className="activity-art-snowcap" d="m28 57 17 21 22-39 17 19-17-7-20 36-20-17-35 56H-8Z" />
    <path className="activity-art-snow" d="M-8 138c35-14 72-9 153-32v82H-8Z" />
    <path className="activity-art-piste" d="M-4 147c40-9 86-6 145-28M-4 158c39-8 84-5 145-27" />
    <path className="activity-art-lift" d="M9 76 127 50M23 73v44M106 55v50M49 67v10h12V64M82 60v10h12V57" />
    <path className="activity-art-building" d="M104 118h24v15h-24zM101 118l15-11 15 11" />
  </>;
}

function GladeScene() {
  return <>
    <path className="activity-art-mountain" d="M-9 114 37 48l20 25 20-34 68 86H-9Z" />
    <path className="activity-art-snowcap" d="m37 48 20 25 20-34 17 21-16-8-20 32-21-20-46 61H-9Z" />
    <path className="activity-art-snow" d="M-8 141c28-24 56-20 79-5s44 13 74-13v65H-8Z" />
    <g className="activity-art-trees"><path d="m9 127 11-25 11 25h-7l10 17H6l10-17Z" /><path d="m106 124 10-23 10 23h-6l9 16h-26l9-16Z" /><path d="m74 118 8-18 8 18h-5l8 13H71l7-13Z" /></g>
    <path className="activity-art-powder" d="M4 159c26-15 48-12 67 0s38 11 62-4" />
  </>;
}

function AlpineScene() {
  return <>
    <path className="activity-art-mountain" d="M-12 124 22 67l18 19 25-51 18 30 13-20 53 80Z" />
    <path className="activity-art-snowcap" d="m22 67 18 19 25-51 18 30 13-20 20 31-18-12-13 17-19-31-24 48-20-17-34 44H-12Z" />
    <path className="activity-art-snow" d="M-8 150c33-16 58-13 80-2s43 8 73-14v54H-8Z" />
    <path className="activity-art-route" d="M12 163c17-27 30-34 47-47s29-25 41-52m-5 5 5-8 3 9" />
    <path className="activity-art-building" d="M108 127h18v12h-18zM105 127l12-9 12 9" />
  </>;
}

function RidgeScene() {
  return <>
    <path className="activity-art-mountain" d="M-12 119 28 63l18 22 27-47 18 29 12-17 46 71Z" />
    <path className="activity-art-snowcap" d="m28 63 18 22 27-47 18 29 12-17 17 26-15-9-11 16-20-32-26 46-21-18-38 42H-12Z" />
    <path className="activity-art-snow" d="M-8 150c35-35 70-24 89-12s39 9 64-12v62H-8Z" />
    <path className="activity-art-powder" d="M4 149c24-25 43-24 62-14s37 13 67-7" />
    <g className="activity-art-trees"><path d="m13 145 9-21 9 21h-5l7 13H11l7-13Z" /><path d="m112 139 7-17 8 17h-5l7 12h-19l6-12Z" /></g>
    <path className="activity-art-route" d="M93 157c-8-16-8-31-3-45s5-26 0-38" />
  </>;
}

function Scene({ name }) {
  if (name === "glade") return <GladeScene />;
  if (name === "alpine") return <AlpineScene />;
  if (name === "ridge") return <RidgeScene />;
  return <ResortScene />;
}

function ResortLandscapeScene() {
  return <>
    <path className="activity-art-mountain" d="M-18 139 72 62l55 48 96-80 84 95 72-62 61 55 91-76 91 98v48H-18Z" />
    <path className="activity-art-snowcap" d="m72 62 55 48 96-80 35 40-34-17-29 25-33-18-35 50Zm307 1 61 55 91-76 38 41-37-18-28 25-31-18-33 46Z" />
    <path className="activity-art-snow" d="M-12 143c93-23 164-12 238-3s157 13 386-20v68H-12Z" />
    <path className="activity-art-piste" d="M-4 158c135-17 251-8 367-12s167-16 241-29M-5 172c137-16 252-7 369-11s166-15 240-28" />
    <path className="activity-art-lift" d="M18 83 579 48M66 80v63M278 67v65M505 53v63M131 76v12h20V75M360 62v12h20V61M530 51v12h20V50" />
    <path className="activity-art-building" d="M74 127h38v21H74zM69 127l24-17 24 17M470 121h42v23h-42zM465 121l26-18 26 18" />
  </>;
}

function GladeLandscapeScene() {
  return <>
    <path className="activity-art-mountain" d="M-20 143 91 52l58 54 91-71 83 91 76-68 64 55 80-72 79 102v45H-20Z" />
    <path className="activity-art-snowcap" d="m91 52 58 54 91-71 36 39-36-16-29 24-31-18-31 42Zm308 6 64 55 80-72 32 42-32-18-25 24-28-18-27 42Z" />
    <path className="activity-art-snow" d="M-12 145c70-31 129-22 185-4s107 17 163-3 121-19 276-8v58H-12Z" />
    <g className="activity-art-trees">
      <path d="m20 146 15-35 15 35h-9l13 23H16l13-23Zm79-11 12-29 13 29h-8l11 20H95l10-20Zm372 7 14-34 15 34h-9l13 23h-38l13-23Zm91-15 11-27 12 27h-7l10 19h-30l10-19Z" />
    </g>
    <path className="activity-art-powder" d="M-2 166c87-24 157-20 222-2s127 16 190-3 126-21 198-9" />
  </>;
}

function AlpineLandscapeScene() {
  return <>
    <path className="activity-art-mountain" d="M-22 148 64 75l47 35 94-79 64 73 61-55 78 78 70-67 48 48 58-72 88 112v40H-22Z" />
    <path className="activity-art-snowcap" d="m64 75 47 35 94-79 31 35-31-13-28 22-27-17-39 52Zm266-26 78 78 70-67 29 30-29-12-22 20-25-15-23 44Zm196 59 58-72 35 44-34-19-24 28Z" />
    <path className="activity-art-snow" d="M-12 151c102-27 184-17 260 1s151 20 364-19v55H-12Z" />
    <path className="activity-art-route" d="M30 175c76-20 104-47 143-76s72-41 118-60m-9 3 11-8 1 13M410 171c32-31 48-53 67-77s38-39 73-54" />
    <path className="activity-art-building" d="M478 135h34v19h-34zM473 135l22-15 22 15" />
  </>;
}

function RidgeLandscapeScene() {
  return <>
    <path className="activity-art-mountain" d="M-20 146 78 65l52 45 83-76 71 79 75-65 70 75 73-61 48 46 54-69 88 107v42H-20Z" />
    <path className="activity-art-snowcap" d="m78 65 52 45 83-76 34 38-34-17-27 24-29-18-27 49Zm281-17 70 75 73-61 28 28-29-10-22 19-24-15-26 39Zm171 60 54-69 34 42-34-17-23 26Z" />
    <path className="activity-art-snow" d="M-12 153c81-41 155-30 221-6s126 21 182-2 119-26 221-10v53H-12Z" />
    <path className="activity-art-powder" d="M-1 165c78-35 147-30 207-9s121 22 181-2 128-30 220-13" />
    <g className="activity-art-trees"><path d="m29 155 13-31 14 31h-8l11 20H24l12-20Zm103-13 11-27 12 27h-7l10 19h-31l11-19Zm337 12 13-31 14 31h-8l11 20h-35l12-20Zm84-18 11-26 11 26h-7l10 18h-29l10-18Z" /></g>
    <path className="activity-art-route" d="M308 174c-17-31-18-57-4-81s18-43 9-61" />
  </>;
}

function LandscapeScene({ name }) {
  if (name === "glade") return <GladeLandscapeScene />;
  if (name === "alpine") return <AlpineLandscapeScene />;
  if (name === "ridge") return <RidgeLandscapeScene />;
  return <ResortLandscapeScene />;
}

function Sprite({ type }) {
  if (type === "dual") return <g className="activity-art-sprite activity-art-sprite-dual">
    <svg x="-3" y="77" width="92" height="82" viewBox="0 0 576 512"><path d={SKIING_PATH} /></svg>
    <svg x="55" y="75" width="86" height="77" viewBox="0 0 576 512"><path d={SNOWBOARDING_PATH} /></svg>
  </g>;
  const path = type === "snowboard" ? SNOWBOARDING_PATH : type === "touring" ? TOURING_PATH : SKIING_PATH;
  const placement = type === "touring" ? { x: 12, y: 73, width: 116, height: 102 } : { x: 12, y: 64, width: 116, height: 104 };
  return <svg className="activity-art-sprite" {...placement} viewBox="0 0 576 512"><path d={path} /></svg>;
}

export default function ActivityArtwork({ listing }) {
  const kind = activityArtworkKind(listing);
  const art = ART[kind];
  return <div className={`activity-artwork activity-artwork-${art.palette}`} role="img" aria-label={`${art.label.toLowerCase()} illustration`}>
    <svg className="activity-artwork-canvas activity-artwork-background activity-artwork-portrait" viewBox="0 0 137 188" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect className="activity-art-sky" width="137" height="188" />
      <Scene name={art.scene} />
      {kind === "splitboard" && <path className="activity-art-split" d="M31 158 75 65M39 161l44-93" />}
    </svg>
    <svg className="activity-artwork-canvas activity-artwork-sprite-layer activity-artwork-portrait" viewBox="0 0 137 188" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <Sprite type={art.sprite} />
    </svg>
    <svg className="activity-artwork-canvas activity-artwork-background activity-artwork-landscape" viewBox="0 0 600 188" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect className="activity-art-sky" width="600" height="188" />
      <LandscapeScene name={art.scene} />
      {kind === "splitboard" && <path className="activity-art-split" d="M263 158 307 65M271 161l44-93" />}
    </svg>
    <svg className="activity-artwork-canvas activity-artwork-sprite-layer activity-artwork-landscape" viewBox="0 0 600 188" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g transform="translate(231.5 0)">
        <Sprite type={art.sprite} />
      </g>
    </svg>
  </div>;
}
