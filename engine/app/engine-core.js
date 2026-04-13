// ============================================================================
// ENGINE CORE — Vitro Omni-Engine // Version 1.2 (True 3D Architecture)
// ============================================================================

import * as THREE from 'three';
import { OrbitControls }          from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }             from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }            from 'three/examples/jsm/loaders/DRACOLoader.js';
import { BufferGeometryUtils }    from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LineSegments2 }          from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry }   from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial }           from 'three/examples/jsm/lines/LineMaterial.js';
import Stats                      from 'three/examples/jsm/libs/stats.module.js';
import { initLighting, updateCSM, setTimeOfDay, registerCSMMaterial, LightingState } from './lighting-system.js';
import { PlayerState, updatePlayerPhysics } from './player.js';
export { setTimeOfDay } from './lighting-system.js';

// ============================================================================
// THREAD YIELDING & LOADING UI
// ============================================================================

const yieldThread = () => new Promise(resolve => setTimeout(resolve, 0));

export function updateLoader(current, total, layerName) {
    const pct = Math.round((current / total) * 100);
    const bar  = document.getElementById('vitro-loader-bar');
    const txt  = document.getElementById('vitro-loader-text');
    const ctr  = document.getElementById('vitro-loader-counter');
    const pctEl = document.getElementById('vitro-loader-pct');
    if (bar)   bar.style.width   = `${pct}%`;
    if (txt)   txt.innerText     = layerName.toUpperCase();
    if (ctr)   ctr.innerText     = `${current} / ${total}`;
    if (pctEl) pctEl.innerText   = `${pct}%`;
}

export function hideLoader() {
    const loader = document.getElementById('vitro-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 500);
    }
}

// ============================================================================
// ENGINE STATE
// ============================================================================

export const Engine = {
    scene:    null,
    camera:   null,
    renderer: null,
    controls: null,
    meta:     null,
    stats:    null,

    matLampFlare: null, 

    groups: {
        bFill:    null,
        bWire:    null,
        roofs:    null,
        detail:   null,
        heroFill: null,
        heroWire: null,
        roads:    null,
        water:    null,
        parks:    null,
        veg:      null,
        rails:    null,
        ski:      null,
        zones:    null,
        micro:    null,
        topo:     null,
        lights:   null,
        tunnels:  null, // underground tube/cavern geometry (walls, floors, ceilings)
        tunnelLights: null, // emissive ceiling strips inside tunnels — zero lighting cost
    },

    // Underground state: driven by the altitude culling state machine in animate().
    // factor lerps 0→1 as the player descends through the terrain; drives fog density,
    // ambient intensity, scene background, and CSM/sky suppression in a single frame.
    underground: {
        state:       'SURFACE',     // SURFACE | TRANSITIONING | UNDERGROUND
        factor:      0.0,           // smoothed 0→1 transition
        targetFactor:0.0,
    },

    // Portal hole buffer — Vector4 array shared by topo shader, building shader, and physics.
    portalHoles: {
        maxHoles: 128, // Safe for GPU caching, high enough for continuous drilling
        count:    0,
        // THE FIX: Must be an array of Vector4s, or Three.js silently drops the uniform!
        data:     Array(128).fill(null).map(() => new THREE.Vector4()),
    },

    uniforms: {
        uPlinthRadius:  { value: 2000.0 },
        uCenter:        { value: new THREE.Vector2(0, 0) },
        uIsolation:     { value: 0.0 },
        uIsolationAlpha:{ value: 0.25 },
        uTime:          { value: 0.0 },
        // Portal hole uniforms, bound via matTopoFill.onBeforeCompile
        uPortalCount:   { value: 0 },
        uPortalHoles:   { value: null }, // Float32Array(64*4), allocated in init()
    },

    center:        { x: 0, z: 0 },
    focusPoint:    { x: 0, z: 0 },
    focusFeatureId: null,

    labels:       [],
    heroState:    { h: 100, feature: null, found: false },
    loadedAssets: {},
    activeAssetId: 'hero_default',
    heroClipPlane:    null,
    currentTheme:     null,
    currentThemeName: 'light',

    UI_MAX:       850,
    FG_THRESHOLD: 400,

    compositeCanvas: null,
    compositeCtx:    null,

    isFlyMode:   false,
    look:        { pitch: 0, yaw: 0 },
    mouseLocked: false,
    keyState:    {},

    treeDensity:    25000,
    maxTrees:       50000,
    treeMesh:       null,
    treeMeshTotal:  0,

    highResGround: false,

    geoCache: { zData: null, pData: null, vData: null, wData: null, skiData: null, hData: null },

    time: {
        mode: 'manual',
        current: 15.0,
        speed: 1.0,
        lastFrame: 0
    },
    
    telemetry: {
        lastUpdate: 0,
        updateInterval: 100 // 10 Hz = 100ms
    },
};

let _topoGrid      = null;   
let _topoWorldSize = 0;      
let _topoInvWorldSize = 0;   
let _topoSizeMinusOne = 0;   
let matTopoFill       = null;
let _lastBakedTheme   = null;
const _ugBgColor = new THREE.Color(0x050508); // target scene.background when fully underground

let _cachedLatScale = null;
let _cachedOriginLon = 0;
let _cachedOriginLat = 0;
const _mPerDeg = 111320;

const _inscriptionFontPromise = new Promise(resolve => {
    new THREE.FontLoader().load(
        'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/fonts/helvetiker_bold.typeface.json',
        font => resolve(font),
        undefined,
        err  => { console.warn('Inscription font failed to load:', err); resolve(null); }
    );
});

// ============================================================================
// O(1) SPATIAL COLLISION GRID
// ============================================================================
export const SpatialGrid = new Map();
const GRID_SIZE = 50.0;

function getGridKeys(minX, maxX, minZ, maxZ) {
    const keys = [];
    const startC = Math.floor(minX / GRID_SIZE);
    const endC   = Math.floor(maxX / GRID_SIZE);
    const startR = Math.floor(minZ / GRID_SIZE);
    const endR   = Math.floor(maxZ / GRID_SIZE);
    for (let c = startC; c <= endC; c++) {
        for (let r = startR; r <= endR; r++) {
            keys.push(`${c}_${r}`);
        }
    }
    return keys;
}

export function injectBridgeSegmentToGrid(p1, p2, halfW) {
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;

    // C-LEVEL OPTIMIZATION: We don't need a polygon ring.
    // We define a Capsule (Line Segment + Radius).
    const radius = halfW + 1.5;

    // Bounding box for the grid injection
    const minX = Math.min(p1.x, p2.x) - radius;
    const maxX = Math.max(p1.x, p2.x) + radius;
    const minZ = Math.min(p1.z, p2.z) - radius;
    const maxZ = Math.max(p1.z, p2.z) + radius;

    const bridgeData = {
        type: 'bridge',
        p1: { x: p1.x, y: p1.y, z: p1.z },
        p2: { x: p2.x, y: p2.y, z: p2.z },
        radiusSq: radius * radius // Pre-compute squared radius to avoid Math.sqrt in hot-loop
    };

    const keys = getGridKeys(minX, maxX, minZ, maxZ);
    for (const k of keys) {
        if (!SpatialGrid.has(k)) SpatialGrid.set(k, []);
        SpatialGrid.get(k).push(bridgeData);
    }
}

// Tunnel segment injection. Stores TWO radii:
//   halfW      — interior walkable half-width (used for inside/lateral-wall test)
//   gridRadius — outer capsule used for grid cell bucketing + getStructureAt filter
// p1.y and p2.y encode the FLOOR elevation at each endpoint (not ceiling).
export function injectTunnelSegmentToGrid(p1, p2, halfW, clearance) {
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return;

    // Outer radius: interior + player radius + slack. The grid filter uses this
    // so the player can "reach" the tube from approach distance. The exact
    // inside/outside-wall decision happens in player physics using halfW.
    const gridRadius = halfW + 1.5;
    const gridRadiusSq = gridRadius * gridRadius;

    const minX = Math.min(p1.x, p2.x) - gridRadius;
    const maxX = Math.max(p1.x, p2.x) + gridRadius;
    const minZ = Math.min(p1.z, p2.z) - gridRadius;
    const maxZ = Math.max(p1.z, p2.z) + gridRadius;

    const tunnelData = {
        type: 'tunnel',
        p1: { x: p1.x, y: p1.y, z: p1.z },
        p2: { x: p2.x, y: p2.y, z: p2.z },
        halfW,
        clearance,
        gridRadiusSq, // for getStructureAt filter only
    };

    const keys = getGridKeys(minX, maxX, minZ, maxZ);
    for (const k of keys) {
        if (!SpatialGrid.has(k)) SpatialGrid.set(k, []);
        SpatialGrid.get(k).push(tunnelData);
    }
}

// Cavern injection — polygon footprint representing an enclosed interior space
// (subway station, underground mall). The player stands on yFloor, ceiling at
// yCeiling, and the ring edges push back inward from the interior.
export function injectCavernToGrid(ring, yFloor, yCeiling) {
    if (!ring || ring.length < 3) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }

    const cavernData = {
        type: 'cavern',
        ring,
        yFloor,
        yCeiling,
    };

    const keys = getGridKeys(minX, maxX, minZ, maxZ);
    for (const k of keys) {
        if (!SpatialGrid.has(k)) SpatialGrid.set(k, []);
        SpatialGrid.get(k).push(cavernData);
    }
}

// Register a portal hole.
// THE FIX: Encode isSurface into the sign of the radius, and pass topY to the W slot.
export function registerPortalHole(cx, cz, radius, isSurface, topY) {
    const ph = Engine.portalHoles;
    if (ph.count >= ph.maxHoles) {
        if (ph.count === ph.maxHoles) console.warn('[Portal] Hole limit reached:', ph.maxHoles);
        return;
    }
    ph.data[ph.count].set(cx, cz, radius, topY);
    ph.count++;
    Engine.uniforms.uPortalCount.value = ph.count;
}

export function resetPortalHoles() {
    const ph = Engine.portalHoles;
    for (let i = 0; i < ph.count; i++) ph.data[i].set(0, 0, 0, 0);
    ph.count = 0;
    Engine.uniforms.uPortalCount.value = 0;
}

// Shared physics/shader query — walks the portal hole array and returns true
// if (x, z) lies inside any registered hole. Tight loop, squared distances.
export function isInPortalHole(x, z) {
    const ph = Engine.portalHoles;
    if (ph.count === 0) return false;
    const d = ph.data;
    for (let i = 0; i < ph.count; i++) {
        const v = d[i]; // Vector4: (cx, cz, radius, topY)
        const r = v.z;
        // Surface tunnels removed

        const dx = x - v.x;
        const dz = z - v.y;
        if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
}

// FUZZY SNAP MATH: point-to-segment squared distance
function distSqToSegment(p, v, w) {
    const l2 = (w.x - v.x) * (w.x - v.x) + (w.z - v.z) * (w.z - v.z);
    if (l2 === 0) return (p.x - v.x) * (p.x - v.x) + (p.z - v.z) * (p.z - v.z);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = v.x + t * (w.x - v.x);
    const projZ = v.z + t * (w.z - v.z);
    return (p.x - projX) * (p.x - projX) + (p.z - projZ) * (p.z - projZ);
}

export function getStructureAt(x, z) {
    // Pure O(1) single lookup. No fat raycasts.
    const key = `${Math.floor(x / GRID_SIZE)}_${Math.floor(z / GRID_SIZE)}`;
    const structures = SpatialGrid.get(key);
    if (!structures) return [];

    const hits = [];
    for (const s of structures) {
        if (s.type === 'building') {
            if (pointInRing(x, z, s.ring)) {
                hits.push({ type: s.type, yTop: s.yTop, yBase: s.yBase, ring: s.ring, p1: s.p1, p2: s.p2 });
            }
        } else if (s.type === 'bridge') {
            const l2 = (s.p2.x - s.p1.x) * (s.p2.x - s.p1.x) + (s.p2.z - s.p1.z) * (s.p2.z - s.p1.z);
            let t = 0;
            if (l2 > 0) {
                t = ((x - s.p1.x) * (s.p2.x - s.p1.x) + (z - s.p1.z) * (s.p2.z - s.p1.z)) / l2;
                t = Math.max(0, Math.min(1, t));
            }
            const projX = s.p1.x + t * (s.p2.x - s.p1.x);
            const projZ = s.p1.z + t * (s.p2.z - s.p1.z);
            const distSq = (x - projX) * (x - projX) + (z - projZ) * (z - projZ);

            if (distSq <= s.radiusSq) {
                const yTop = s.p1.y + t * (s.p2.y - s.p1.y);
                const yBase = yTop - 5.0;
                hits.push({ type: s.type, yTop, yBase, p1: s.p1, p2: s.p2 });
            }
        } else if (s.type === 'tunnel') {
            const l2 = (s.p2.x - s.p1.x) * (s.p2.x - s.p1.x) + (s.p2.z - s.p1.z) * (s.p2.z - s.p1.z);
            let t = 0;
            if (l2 > 0) {
                t = ((x - s.p1.x) * (s.p2.x - s.p1.x) + (z - s.p1.z) * (s.p2.z - s.p1.z)) / l2;
                t = Math.max(0, Math.min(1, t));
            }
            const projX = s.p1.x + t * (s.p2.x - s.p1.x);
            const projZ = s.p1.z + t * (s.p2.z - s.p1.z);
            const distSq = (x - projX) * (x - projX) + (z - projZ) * (z - projZ);

            if (distSq <= s.gridRadiusSq) {
                hits.push(s);
            }
        } else if (s.type === 'bridgePoly') {
            if (pointInRing(x, z, s.ring)) {
                hits.push({ type: 'bridgePoly', yTop: s.yTop, yBase: s.yTop - 0.5 });
            } else {
                // THE FIX: Fuzzy Snap for staircases attached to polygon edges
                let minDistSq = Infinity;
                const p = { x, z };
                for (let i = 0, j = s.ring.length - 1; i < s.ring.length; j = i++) {
                    const dSq = distSqToSegment(p, s.ring[j], s.ring[i]);
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq <= 6.25) { // If within 2.5 meters of the edge, snap to deck!
                    hits.push({ type: 'bridgePoly', yTop: s.yTop, yBase: s.yTop - 0.5 });
                }
            }
        } else if (s.type === 'cavern') {
            if (pointInRing(x, z, s.ring)) {
                hits.push(s);
            }
        }
    }
    return hits;
}


export function getBridgeAwareY(x, z) {
    const structs = getStructureAt(x, z);
    let bridgeY = -Infinity;
    for (const s of structs) {
        // THE FIX: ONLY snap to bridgePoly (Plazas). DO NOT snap to overpass bridges!
        if (s.type === 'bridgePoly' && s.yTop > bridgeY) bridgeY = s.yTop;
    }
    return bridgeY > -Infinity ? bridgeY : getElevationAt(x, z);
}

// ============================================================================
// THEMES
// ============================================================================

export const THEMES = {
    light: {
        bg: 0xfafaf7, bFill: 0xffffff, ink: 0x141210, road: 0x404040, sidewalk: 0x8a8a88, rail: 0x202020,
        water: 0x94bcd4, park: 0xcde0c4, pitch: 0xd8eeac, stadium: 0xc4d8b0, nature_reserve: 0xb4cc9c,
        forest: 0xa8c490, veg: 0xdce8d0, scrub: 0xd0c8aa, terrain: 0xe8dfc4,
        grass: 0xb5d29c, farmland: 0xd2d2a0, sand: 0xe6d4b8,
        parking: 0x5a5a5c, plaza: 0xd8d8d8, aeroway: 0x4a4a4c,
        institutional: 0xf0eeea, residential: 0xf2f0ec, commercial: 0xe8ecf2, industrial: 0xdddad4, cemetery: 0xd4d8cc, military: 0xd8d4c4,
        tree: 0x4a8a3a, barrier: 0xc8c4bc, furniture: 0xb0aaa0, topo: 0xf0efe8,
        skiRun: 0xffffff, skiLift: 0x111111,
        hdrBg: '#fafaf7', hdrText: '#141210', grid: false, isolationAlpha: 0.25,
    },
    graphite: {
        bg: 0x0e0e0e, bFill: 0x2e2e2e, ink: 0xffffff, road: 0x9a9a9a, sidewalk: 0x505050, rail: 0xb8b8b8,
        water: 0x0d1a24, park: 0x0e1c0c, pitch: 0x141e08, stadium: 0x101a0e, nature_reserve: 0x0c1608,
        forest: 0x0a1408, veg: 0x141a10, scrub: 0x181612, terrain: 0x1e1c14,
        grass: 0x0e1a0a, farmland: 0x181810, sand: 0x1e1a12,
        parking: 0x252526, plaza: 0x2a2a2a, aeroway: 0x222224,
        institutional: 0x1c1c20, residential: 0x181818, commercial: 0x181820, industrial: 0x161614, cemetery: 0x121812, military: 0x161814,
        tree: 0x1a3010, barrier: 0x2a2a2a, furniture: 0x222220, topo: 0x1a1a1a,
        skiRun: 0xffffff, skiLift: 0x888888,
        hdrBg: '#0e0e0e', hdrText: '#ffffff', grid: true,  isolationAlpha: 0.30,
    },
    blueprint: {
        bg: 0x060e1e, bFill: 0x0c2850, ink: 0xffffff, road: 0x80b8e8, sidewalk: 0x406080, rail: 0xa0d0ff,
        water: 0x020810, park: 0x060e1e, pitch: 0x080f20, stadium: 0x060d1c, nature_reserve: 0x060e1e,
        forest: 0x060e1e, veg: 0x080e20, scrub: 0x070c1a, terrain: 0x0a0e1c,
        grass: 0x060e18, farmland: 0x0a0e18, sand: 0x0c1020,
        parking: 0x0a1530, plaza: 0x0e1d40, aeroway: 0x0c1230,
        institutional: 0x0a1828, residential: 0x070e1c, commercial: 0x081428, industrial: 0x0c1018, cemetery: 0x070c14, military: 0x090e14,
        tree: 0x080f1c, barrier: 0x162850, furniture: 0x12244a, topo: 0x081428,
        skiRun: 0xffffff, skiLift: 0x888888,
        hdrBg: '#060e1e', hdrText: '#ffffff', grid: true,  isolationAlpha: 0.30,
    },
    onyx: {
        bg: 0x191919, bFill: 0xffffff, ink: 0x2c2c2c, road: 0x808080, sidewalk: 0x444444, rail: 0x9a9a9a,
        water: 0x06080c, park: 0x0c1008, pitch: 0x101408, stadium: 0x0e1208, nature_reserve: 0x0a0e08,
        forest: 0x080c06, veg: 0x101410, scrub: 0x141210, terrain: 0x181610,
        grass: 0x0e1a0a, farmland: 0x181810, sand: 0x1e1a12,
        parking: 0x252525, plaza: 0x2c2c2c, aeroway: 0x222222,
        institutional: 0x1e1e1e, residential: 0x1a1a1a, commercial: 0x1a1a1e, industrial: 0x181818, cemetery: 0x141814, military: 0x161814,
        tree: 0x142a10, barrier: 0x282828, furniture: 0x242424, topo: 0x222222,
        skiRun: 0xffffff, skiLift: 0x888888,
        hdrBg: '#191919', hdrText: '#ffffff', grid: false, isolationAlpha: 0.25,
    },
    amber: {
        bg: 0x150f04, bFill: 0xf0c860, ink: 0x1e1408, road: 0xb08030, sidewalk: 0x604820, rail: 0xd8b060,
        water: 0x060810, park: 0x101006, pitch: 0x141408, stadium: 0x121008, nature_reserve: 0x0e1006,
        forest: 0x0c0e04, veg: 0x141208, scrub: 0x18140a, terrain: 0x1c160a,
        grass: 0x141408, farmland: 0x1c1a08, sand: 0x221a0a,
        parking: 0x201808, plaza: 0x282010, aeroway: 0x1c1608,
        institutional: 0x1c1610, residential: 0x18120c, commercial: 0x18140e, industrial: 0x161210, cemetery: 0x14140c, military: 0x16140a,
        tree: 0x1a2808, barrier: 0x382810, furniture: 0x2c2010, topo: 0x1c1608,
        skiRun: 0xe8e0d0, skiLift: 0x4a4030,
        hdrBg: '#150f04', hdrText: '#f0c860', grid: false, isolationAlpha: 0.30,
    },
    slate: {
        bg: 0x272c32, bFill: 0xe0e0d8, ink: 0x363c42, road: 0x9aa0b0, sidewalk: 0x586068, rail: 0xb8c0c8,
        water: 0x121820, park: 0x18201a, pitch: 0x1e2418, stadium: 0x1a2018, nature_reserve: 0x161e18,
        forest: 0x141c14, veg: 0x1c2018, scrub: 0x201e18, terrain: 0x242018,
        grass: 0x182018, farmland: 0x1e2018, sand: 0x22201a,
        parking: 0x2a2c30, plaza: 0x323438, aeroway: 0x28282c,
        institutional: 0x262a2e, residential: 0x24262a, commercial: 0x242830, industrial: 0x222428, cemetery: 0x1e2422, military: 0x202422,
        tree: 0x1e3a1a, barrier: 0x353840, furniture: 0x2e3038, topo: 0x2e3338,
        skiRun: 0xd8d8d0, skiLift: 0x505860,
        hdrBg: '#272c32', hdrText: '#e0e0d8', grid: false, isolationAlpha: 0.25,
    },
};

// ============================================================================
// SHADERS
// ============================================================================

// Injects dashed center-line lane markings into any road material shader.
// Reads a custom 'roadUV' attribute (not Three.js's standard UV system) so it
// works unconditionally — geometries without 'roadUV' silently draw nothing.
// U=0 right edge, U=1 left edge; V=accumulated distance / 4m per tile.
function applyLaneLineShader(shader) {
    shader.vertexShader = `attribute vec2 roadUV;\nattribute float roadED;\nvarying vec2 vRoadUV;\nvarying float vRoadED;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n    vRoadUV = roadUV;\n    vRoadED = roadED;`
    );
    shader.fragmentShader = `varying vec2 vRoadUV;\nvarying float vRoadED;\n${shader.fragmentShader}`.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
            float dashCycle = fract(vRoadUV.y);
            // Dash on for first 50% of each 4m tile, off for second 50%
            float isDash = step(0.0, dashCycle) * (1.0 - step(0.5, dashCycle));
            // Smooth-edged stripe centred at U=0.5, half-width ~4% of road width
            float lineAlpha = smoothstep(0.06, 0.03, abs(vRoadUV.x - 0.5));
            // Hard cutoff 3m from each segment endpoint — lines stop cleanly at intersections.
            // roadED = 0 on footpaths/unmarked roads — suppressed entirely.
            lineAlpha *= step(3.0, vRoadED);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), lineAlpha * isDash);
        }`
    );
}

function applyBaseShader(shader) {
    shader.uniforms.uPlinthRadius = Engine.uniforms.uPlinthRadius;
    shader.uniforms.uCenter       = Engine.uniforms.uCenter;
    shader.vertexShader = `varying vec3 vCustomWorldPos;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n         vCustomWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`
    );
    shader.fragmentShader = `uniform float uPlinthRadius;\nuniform vec2 uCenter;\nvarying vec3 vCustomWorldPos;\n${shader.fragmentShader}`.replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>\n         if (length(vec2(vCustomWorldPos.x - uCenter.x, vCustomWorldPos.z - uCenter.y)) > uPlinthRadius) discard;`
    );
}

function applyContextShader(shader) {
    shader.uniforms.uPlinthRadius   = Engine.uniforms.uPlinthRadius;
    shader.uniforms.uCenter         = Engine.uniforms.uCenter;
    shader.uniforms.uIsolation      = Engine.uniforms.uIsolation;
    shader.uniforms.uIsolationAlpha = Engine.uniforms.uIsolationAlpha;
    shader.vertexShader = `varying vec3 vCustomWorldPos;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n         vCustomWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`
    );
    shader.fragmentShader = `uniform float uPlinthRadius;\nuniform vec2 uCenter;\nuniform float uIsolation;\nuniform float uIsolationAlpha;\nvarying vec3 vCustomWorldPos;\n${shader.fragmentShader}`.replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>\n         if (length(vec2(vCustomWorldPos.x - uCenter.x, vCustomWorldPos.z - uCenter.y)) > uPlinthRadius) discard;`
    );
}

function applyBaseShaderLine2(shader) {
    shader.uniforms.uPlinthRadius = Engine.uniforms.uPlinthRadius;
    shader.uniforms.uCenter       = Engine.uniforms.uCenter;
    shader.vertexShader = `varying vec3 vCustomWorldPos;\n${shader.vertexShader}`.replace(
        /vec4 end\s*=\s*modelViewMatrix\s*\*\s*vec4\(\s*instanceEnd\s*,\s*1\.0\s*\)\s*;/,
        `$&\n         vec3 _wS = (modelMatrix * vec4(instanceStart, 1.0)).xyz;\n         vec3 _wE = (modelMatrix * vec4(instanceEnd,   1.0)).xyz;\n         vCustomWorldPos = (position.y < 0.5) ? _wS : _wE;`
    );
    shader.fragmentShader = `uniform float uPlinthRadius;\nuniform vec2 uCenter;\nvarying vec3 vCustomWorldPos;\n${shader.fragmentShader}`.replace(
        'void main() {',
        `void main() {\n         if (length(vec2(vCustomWorldPos.x - uCenter.x, vCustomWorldPos.z - uCenter.y)) > uPlinthRadius) discard;`
    );
}

function applyContextShaderLine2(shader) {
    shader.uniforms.uPlinthRadius   = Engine.uniforms.uPlinthRadius;
    shader.uniforms.uCenter         = Engine.uniforms.uCenter;
    shader.uniforms.uIsolation      = Engine.uniforms.uIsolation;
    shader.uniforms.uIsolationAlpha = Engine.uniforms.uIsolationAlpha;
    shader.vertexShader = `varying vec3 vCustomWorldPos;\n${shader.vertexShader}`.replace(
        /vec4 end\s*=\s*modelViewMatrix\s*\*\s*vec4\(\s*instanceEnd\s*,\s*1\.0\s*\)\s*;/,
        `$&\n         vec3 _wS = (modelMatrix * vec4(instanceStart, 1.0)).xyz;\n         vec3 _wE = (modelMatrix * vec4(instanceEnd,   1.0)).xyz;\n         vCustomWorldPos = (position.y < 0.5) ? _wS : _wE;`
    );
    shader.fragmentShader = `uniform float uPlinthRadius;\nuniform vec2 uCenter;\nuniform float uIsolation;\nuniform float uIsolationAlpha;\nvarying vec3 vCustomWorldPos;\n${shader.fragmentShader}`.replace(
        'void main() {',
        `void main() {\n         if (length(vec2(vCustomWorldPos.x - uCenter.x, vCustomWorldPos.z - uCenter.y)) > uPlinthRadius) discard;`
    );
}

function applyInstancedBaseShader(shader) {
    shader.uniforms.uPlinthRadius = Engine.uniforms.uPlinthRadius;
    shader.uniforms.uCenter       = Engine.uniforms.uCenter;
    shader.vertexShader = `varying vec3 vCustomWorldPos;\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n
        #ifdef USE_INSTANCING
            vCustomWorldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
            vCustomWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        #endif`
    );
    shader.fragmentShader = `uniform float uPlinthRadius;\nuniform vec2 uCenter;\nvarying vec3 vCustomWorldPos;\n${shader.fragmentShader}`.replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>\n         if (length(vec2(vCustomWorldPos.x - uCenter.x, vCustomWorldPos.z - uCenter.y)) > uPlinthRadius) discard;`
    );
}

function isWireObject(c) { return !!(c.isLineSegments || c.isLine || c.isLineSegments2 || c.material?.isLineMaterial); }
function setMatProp(c, prop, val) { const m = c.material; if (Array.isArray(m)) m.forEach(mt => { mt[prop] = val; }); else if (m) m[prop] = val; }

function edgesToLineGeo(bufGeo) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(bufGeo.attributes.position.array);
    bufGeo.dispose();
    return geo;
}

function plinthClone(mat) {
    const c = mat.clone();
    registerCSMMaterial(c);
    c.onBeforeCompile = mat.onBeforeCompile;
    return c;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export function init(container, meta) {
    Engine.meta          = meta;
    Engine.heroClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.0);
    Engine.currentTheme  = THEMES.light;
    Engine.uniforms.uIsolationAlpha.value = THEMES.light.isolationAlpha;

    // Bind portal hole uniform to the Vector4 array (shared by topo shader + building shader)
    Engine.uniforms.uPortalHoles.value = Engine.portalHoles.data;

    Engine.scene = new THREE.Scene();
    Engine.scene.background = new THREE.Color(Engine.currentTheme.bg); 

    Engine.renderer = new THREE.WebGLRenderer({
        antialias:              true,
        preserveDrawingBuffer:  true,
        powerPreference:        'high-performance',
        alpha:                  true,
        premultipliedAlpha:     false,
        logarithmicDepthBuffer: true,
    });
    
    const SSAA = 1;
    Engine.renderer.setPixelRatio(Math.min(window.devicePixelRatio * SSAA, 1));
    Engine.renderer.localClippingEnabled = true;
    Engine.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    Engine.renderer.toneMappingExposure = 0.85;
    // THE FIX: Unhide the WebGL canvas so the GPU can draw directly to the screen!
    Engine.renderer.domElement.style.display = 'block';
    container.appendChild(Engine.renderer.domElement);

    // Engine.stats = new Stats();
    // Engine.stats.showPanel(0);
    // container.appendChild(Engine.stats.dom);

    // Keep the composite canvas purely as an off-screen buffer for exporting.
    // We remove it from the live DOM to save massive amounts of memory and CPU overhead.
    Engine.compositeCanvas = document.createElement('canvas');
    Engine.compositeCtx    = Engine.compositeCanvas.getContext('2d');

    const fov = 45;
    const aspect = 1;
    const near = .1;
    const far = 50000;

    Engine.camera = new THREE.PerspectiveCamera(fov, aspect, near, far);

    const r = meta.radius || 1000;
    Engine.camera.position.set(r, r, r);

    // THE FIX: Bind controls directly to the hardware-accelerated WebGL canvas
    Engine.controls = new OrbitControls(Engine.camera, Engine.renderer.domElement);
    Engine.controls.enableDamping  = true;
    Engine.controls.dampingFactor  = 1;
    Engine.controls.autoRotate     = false;
    Engine.controls.autoRotateSpeed = 1.0;

    Engine.controls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_ROTATE
    };

    Engine.controls.addEventListener('change', () => {
    });

    Engine.controls.addEventListener('end', () => {
        Engine.center.x = Engine.controls.target.x;
        Engine.center.z = Engine.controls.target.z;
        updateStyles();
    });

    for (const key of Object.keys(Engine.groups)) {
        Engine.groups[key] = new THREE.Group();
        Engine.scene.add(Engine.groups[key]);
    }

    const plinthSlider = document.getElementById('sldPlinth');
    if (plinthSlider) {
        if (meta?.radius) {
            const r = meta.radius;
            plinthSlider.min   = Math.max(10,  Math.round(r * 0.05));
            plinthSlider.max   = Math.round(r * 3.0);
            plinthSlider.step  = Math.max(5,   Math.round(r * 0.01));
            plinthSlider.value = Math.round(r * 0.75);
        }
        Engine.uniforms.uPlinthRadius.value = parseFloat(plinthSlider.value);
        const plinthLbl = document.getElementById('vPlinth');
        if (plinthLbl) plinthLbl.innerText = plinthSlider.value;
    }

    updateLayout();
    centerCamera();

    const btnPlayer = document.getElementById('btnTogglePlayer');
    if (btnPlayer) {
        btnPlayer.addEventListener('click', () => {
            PlayerState.isActive = !PlayerState.isActive;
            
            if (PlayerState.isActive) {
                Engine.controls.enabled = false;
                Engine.isFlyMode = false; 
                
                const euler = new THREE.Euler().setFromQuaternion(Engine.camera.quaternion, 'YXZ');
                PlayerState.cameraHeading = euler.y;
                PlayerState.bodyHeading   = euler.y;
                PlayerState.cameraPitch   = euler.x; 
                PlayerState.velocity.set(0,0,0);

                btnPlayer.classList.add('active');
                btnPlayer.innerText = 'PLAYER MODE: ON (WASD / Shift / Space)';
            } else {
                Engine.controls.enabled = true;
                
                const dir = new THREE.Vector3();
                Engine.camera.getWorldDirection(dir);
                Engine.controls.target.copy(Engine.camera.position).addScaledVector(dir, 100);
                Engine.controls.update();

                btnPlayer.classList.remove('active');
                btnPlayer.innerText = 'PLAYER MODE: OFF (Get Close To Map)';
            }
        });
    }

    initLighting(Engine.scene, Engine.renderer, meta, Engine.camera);

    // --- Fly-mode pointer-lock mouse look ---
    const flyCanvas = Engine.renderer.domElement;

    flyCanvas.addEventListener('mousedown', () => {
        if (Engine.isFlyMode || PlayerState.isActive) flyCanvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        Engine.mouseLocked = document.pointerLockElement === flyCanvas;
    });

    document.addEventListener('mousemove', e => {
        if (!Engine.mouseLocked) return;
        const sensitivity = 0.002;

        if (Engine.isFlyMode) {
            Engine.look.yaw   -= e.movementX * sensitivity;
            Engine.look.pitch -= e.movementY * sensitivity;
            const lookDownLimit = -(Math.PI / 2 - 0.01);
            const lookUpLimit = Math.PI / 6; 
            Engine.look.pitch = Math.max(lookDownLimit, Math.min(lookUpLimit, Engine.look.pitch));
            Engine.camera.rotation.order = 'YXZ';
            Engine.camera.rotation.set(Engine.look.pitch, Engine.look.yaw, 0);
            
        } else if (PlayerState.isActive) {
            PlayerState.cameraHeading -= e.movementX * sensitivity;
            PlayerState.cameraPitch   -= e.movementY * sensitivity;
            
            const PI_2 = Math.PI / 2 - 0.05;
            PlayerState.cameraPitch = Math.max(-PI_2, Math.min(PI_2, PlayerState.cameraPitch));
        }
    });

    document.querySelectorAll('input[type="range"]').forEach(slider => {
        slider.addEventListener('mouseup', (e) => e.target.blur());
        slider.addEventListener('touchend', (e) => e.target.blur());
    });

    const selTimeMode = document.getElementById('selTimeMode');
    const wrapManual = document.getElementById('wrapManualTime');
    const wrapAuto = document.getElementById('wrapAutoSpeed');
    const sldTime = document.getElementById('sldTime');
    const timeLbl = document.getElementById('vTime');
    const sldSpeed = document.getElementById('sldTimeSpeed');
    const speedLbl = document.getElementById('vTimeSpeed');

    const formatTime = (t) => {
        const h = Math.floor(t);
        const m = Math.floor((t % 1) * 60).toString().padStart(2, '0');
        return `${h}:${m}`;
    };

    if (selTimeMode) {
        selTimeMode.addEventListener('change', (e) => {
            Engine.time.mode = e.target.value;
            wrapManual.style.display = Engine.time.mode === 'manual' ? 'block' : 'none';
            wrapAuto.style.display = Engine.time.mode === 'auto' ? 'block' : 'none';
        });
    }

    if (sldTime) {
        Engine.time.current = parseFloat(sldTime.value);
        setTimeOfDay(Engine.time.current);
        timeLbl.innerText = formatTime(Engine.time.current);

        sldTime.addEventListener('input', (e) => {
            if (Engine.time.mode !== 'manual') return;
            Engine.time.current = parseFloat(e.target.value);
            setTimeOfDay(Engine.time.current);
            if (timeLbl) timeLbl.innerText = formatTime(Engine.time.current);
        });
    }

    if (sldSpeed) {
        sldSpeed.addEventListener('input', (e) => {
            Engine.time.speed = parseFloat(e.target.value);
            if (speedLbl) speedLbl.innerText = Engine.time.speed.toFixed(1) + 'x';
        });
    }

    const btnLights = document.getElementById('btnToggleLights');
    if (btnLights) {
        btnLights.addEventListener('click', () => {
            const isVisible = Engine.groups.lights.visible;
            Engine.groups.lights.visible = !isVisible;
            btnLights.classList.toggle('active');
            btnLights.innerText = Engine.groups.lights.visible ? 'LIGHTS: ON' : 'LIGHTS: OFF';
            btnLights.style.backgroundColor = Engine.groups.lights.visible ? 'rgba(255, 255, 255, 0.2)' : 'transparent';
        });
    }

    animate();
}

export function disposeGroup(group) {
    group.traverse(node => {
        if (node === group) return;
        node.geometry?.dispose();
        if (Array.isArray(node.material)) node.material.forEach(m => m.dispose());
        else node.material?.dispose();
    });
    while (group.children.length > 0) group.remove(group.children[0]);
}

// ============================================================================
// GEOSPATIAL MATH
// ============================================================================

function getLocalSolarTime(longitude) {
    const now = new Date();
    const utcHours = now.getUTCHours() + (now.getUTCMinutes() / 60) + (now.getUTCSeconds() / 3600);
    return (utcHours + (longitude / 15) + 24) % 24;
}

export function project(lon, lat) {
    if (_cachedLatScale === null) {
        _cachedOriginLon = Engine.meta?.lon || 0;
        _cachedOriginLat = Engine.meta?.lat || 0;
        _cachedLatScale = Math.cos(_cachedOriginLat * (Math.PI / 180));
    }
    return {
        x: (lon - _cachedOriginLon) * _mPerDeg * _cachedLatScale,
        y: (lat - _cachedOriginLat) * _mPerDeg,
        valid: true,
    };
}

export function getElevationAt(x, z) {
    if (!_topoGrid) return 0;
    const radius = _topoWorldSize * 0.5;

    let percentX = (x + radius) * _topoInvWorldSize;
    let percentZ = (z + radius) * _topoInvWorldSize;

    if (percentX < 0) percentX = 0; else if (percentX > 1) percentX = 1;
    if (percentZ < 0) percentZ = 0; else if (percentZ > 1) percentZ = 1;

    const gi = percentX * _topoSizeMinusOne;   
    const gj = percentZ * _topoSizeMinusOne;   

    const x0 = Math.min(_topoSizeMinusOne - 1, gi | 0);
    const z0 = Math.min(_topoSizeMinusOne - 1, gj | 0);
    const x1 = x0 + 1, z1 = z0 + 1;
    const fx = gi - x0, fz = gj - z0;

    const SIZE = _topoGrid.size;
    const d = _topoGrid.data;

    const h00 = d[z0 * SIZE + x0]; 
    const h10 = d[z0 * SIZE + x1]; 
    const h01 = d[z1 * SIZE + x0]; 
    const h11 = d[z1 * SIZE + x1]; 

    if (fx + fz <= 1.0) {
        return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    } else {
        return h11 + (1.0 - fx) * (h01 - h11) + (1.0 - fz) * (h10 - h11);
    }
}

export function toggleCamera() {
    const isOrtho = !!Engine.camera.isOrthographicCamera;
    const target = Engine.controls.target.clone();
    const dist = Engine.camera.position.distanceTo(target);
    const dir = new THREE.Vector3().subVectors(Engine.camera.position, target).normalize();

    const fov = 45;
    const aspect = Engine.renderer.domElement.width / Engine.renderer.domElement.height;
    const radius = Engine.meta?.radius || 1000;
    const f = radius * 4.0;

    if (isOrtho) {
        const currentVisHeight = f / Engine.camera.zoom;
        const newDist = currentVisHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
        Engine.camera = new THREE.PerspectiveCamera(fov, aspect, 10, 50000);
        Engine.camera.position.copy(target).addScaledVector(dir, newDist);
    } else {
        const currentVisHeight = 2 * dist * Math.tan(THREE.MathUtils.degToRad(fov / 2));
        const newZoom = f / currentVisHeight;
        Engine.camera = new THREE.OrthographicCamera(-f * aspect / 2, f * aspect / 2, f / 2, -f / 2, -50000, 50000);
        Engine.camera.position.copy(target).addScaledVector(dir, radius * 4);
        Engine.camera.zoom = newZoom;
    }

    Engine.camera.lookAt(target);
    Engine.camera.updateProjectionMatrix();
    Engine.controls.object = Engine.camera;
    Engine.controls.update();

    updateLayout();
    updateStyles();
}

export function getRings(geom) {
    if (geom.type === 'Polygon')      return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
}

function pointInRing(x, z, ring) {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i].x, zi = ring[i].z;
        const xj = ring[j].x, zj = ring[j].z;
        if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function initVegetation(vData, sData, railData) {
    if (!vData?.features?.length) return;

    const blockedCells = new Set();
    const CELL_SIZE = 6.0;

    function blockPath(data) {
        if (!data?.features) return;
        for (const f of data.features) {
            const gt = f.geometry?.type;
            if (gt !== 'LineString' && gt !== 'MultiLineString') continue;

            const coords = gt === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
            for (const path of coords) {
                let lastValid = null;
                for (const pt of path) {
                    const proj = project(pt[0], pt[1]);
                    if (!proj.valid) continue;
                    const v = new THREE.Vector2(proj.x, -proj.y);

                    if (lastValid) {
                        const dist = lastValid.distanceTo(v);
                        const steps = Math.max(1, Math.ceil(dist / (CELL_SIZE / 2)));
                        for (let i = 0; i <= steps; i++) {
                            const p = new THREE.Vector2().lerpVectors(lastValid, v, i / steps);
                            const cx = Math.floor(p.x / CELL_SIZE);
                            const cz = Math.floor(p.y / CELL_SIZE);

                            blockedCells.add(`${cx}_${cz}`);
                            blockedCells.add(`${cx+1}_${cz}`);
                            blockedCells.add(`${cx-1}_${cz}`);
                            blockedCells.add(`${cx}_${cz+1}`);
                            blockedCells.add(`${cx}_${cz-1}`);
                        }
                    }
                    lastValid = v;
                }
            }
        }
    }

    blockPath(sData);
    blockPath(railData);

    const canopyGeo = new THREE.ConeGeometry(1.5, 4.0, 5);
    canopyGeo.translate(0, 3.5, 0);
    const trunkGeo  = new THREE.CylinderGeometry(0.2, 0.25, 1.5, 4);
    trunkGeo.translate(0, 0.75, 0);
    const treeGeo   = BufferGeometryUtils.mergeBufferGeometries([canopyGeo, trunkGeo]);
    canopyGeo.dispose(); trunkGeo.dispose();

    const matTree = new THREE.MeshLambertMaterial({ color: 0x4a8a3a });
    registerCSMMaterial(matTree);
    const csmCompileTree = matTree.onBeforeCompile;
    matTree.onBeforeCompile = (shader, renderer) => {
        applyInstancedBaseShader(shader);
        shader.uniforms.uTime = Engine.uniforms.uTime;
        shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             vec3 _wPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
             float sway = sin(_wPos.x * 0.05 + uTime * 1.5) * sin(_wPos.z * 0.05 + uTime * 1.2);
             transformed.x += sway * max(0.0, position.y - 0.5) * 0.15;
             transformed.z += sway * max(0.0, position.y - 0.5) * 0.15;
            `
        );
        csmCompileTree(shader, renderer);
    };

    const MAX = Engine.maxTrees;
    const iMesh = new THREE.InstancedMesh(treeGeo, matTree, MAX);
    iMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    iMesh.frustumCulled = false;
    iMesh.castShadow    = true;
    iMesh.receiveShadow = true;
    iMesh.userData.colorKey = 'tree';

    const dummy = new THREE.Object3D();
    const radius = Engine.meta?.radius || 1000;

    let totalPotential = 0;
    const polygonJobs = [];

    for (const feature of vData.features) {
        if (!feature.geometry) continue;
        for (const ring of getRings(feature.geometry)) {
            if (!ring[0] || ring[0].length < 3) continue;

            const worldRing = ring[0].map(pt => {
                const p = project(pt[0], pt[1]);
                return { x: p.x, z: -p.y };
            });

            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            let trueArea = 0;

            for (let i = 0; i < worldRing.length; i++) {
                const p = worldRing[i];
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;

                const nextP = worldRing[(i + 1) % worldRing.length];
                trueArea += (p.x * nextP.z) - (nextP.x * p.z);
            }
            trueArea = Math.abs(trueArea) / 2.0;

            const potential = Math.max(1, Math.floor(trueArea / 100));
            totalPotential += potential;
            polygonJobs.push({ worldRing, bounds: { minX, maxX, minZ, maxZ }, potential });
        }
    }

    const globalScale = MAX / (totalPotential || 1);
    let totalCount = 0;

    for (const job of polygonJobs) {
        if (totalCount >= MAX) break;

        const countForThisPoly = Math.ceil(job.potential * globalScale);
        const { minX, maxX, minZ, maxZ } = job.bounds;

        for (let i = 0; i < countForThisPoly; i++) {
            if (totalCount >= MAX) break;

            for (let attempt = 0; attempt < 10; attempt++) {
                const rx = minX + Math.random() * (maxX - minX);
                const rz = minZ + Math.random() * (maxZ - minZ);

                if (Math.hypot(rx, rz) > radius) continue;
                if (!pointInRing(rx, rz, job.worldRing)) continue;

                const cx = Math.floor(rx / CELL_SIZE);
                const cz = Math.floor(rz / CELL_SIZE);
                if (blockedCells.has(`${cx}_${cz}`)) continue;

                const y = getElevationAt(rx, rz);
                const scale = 0.5 + Math.random() * 1.0;

                dummy.position.set(rx, y, rz);
                dummy.scale.set(scale, scale, scale);
                dummy.rotation.y = Math.random() * Math.PI * 2;
                dummy.updateMatrix();
                iMesh.setMatrixAt(totalCount++, dummy.matrix);
                break;
            }
        }
    }

    iMesh.count = totalCount;
    iMesh.instanceMatrix.needsUpdate = true;
    Engine.treeMesh = iMesh;
    Engine.treeMeshTotal = totalCount;
    Engine.groups.veg.add(iMesh);
}

export function getFirstCoord(geom) {
    if (geom.type === 'Polygon'      && geom.coordinates[0])    return geom.coordinates[0][0];
    if (geom.type === 'MultiPolygon' && geom.coordinates[0][0]) return geom.coordinates[0][0][0];
    if (geom.type === 'LineString'   && geom.coordinates)       return geom.coordinates[0];
    return null;
}

export function buildShape(polyArrays) {
    if (!polyArrays?.[0]) return null;

    const shape     = new THREE.Shape();
    const validRing = [];

    for (const p of polyArrays[0]) {
        if (!p || p.length < 2) continue;
        const v = project(p[0], p[1]);
        if (v.valid) validRing.push(v);
    }
    if (validRing.length < 3) return null;

    const first = validRing[0];
    const last = validRing[validRing.length - 1];
    const gapDist = Math.hypot(last.x - first.x, last.y - first.y);

    const mapRadius = Engine.meta?.radius || 1000;
    const firstDist = Math.hypot(first.x, first.y);
    const lastDist = Math.hypot(last.x, last.y);

    if (gapDist > mapRadius * 0.25 && firstDist > mapRadius * 0.8 && lastDist > mapRadius * 0.8) {
        const mx = (first.x + last.x) / 2;
        const my = (first.y + last.y) / 2;

        let distCenter = Math.hypot(mx, my);
        let dirX = mx, dirY = my;

        if (distCenter < 1) {
            dirX = 1; dirY = 0; 
        } else {
            dirX /= distCenter; dirY /= distCenter;
        }

        const EXTENT = mapRadius * 10; 
        validRing.push({ x: last.x + dirX * EXTENT, y: last.y + dirY * EXTENT });
        validRing.push({ x: first.x + dirX * EXTENT, y: first.y + dirY * EXTENT });
    }

    let area = 0;
    for (let i = 0; i < validRing.length; i++) {
        const j = (i + 1) % validRing.length;
        area += validRing[i].x * validRing[j].y;
        area -= validRing[j].x * validRing[i].y;
    }
    if (area < 0) validRing.reverse();
    validRing.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));

    for (let i = 1; i < polyArrays.length; i++) {
        const validHole = [];
        for (const p of polyArrays[i]) {
            if (!p || p.length < 2) continue;
            const v = project(p[0], p[1]);
            if (v.valid) validHole.push(v);
        }
        if (validHole.length < 3) continue;

        let holeArea = 0;
        for (let k = 0; k < validHole.length; k++) {
            const j = (k + 1) % validHole.length;
            holeArea += validHole[k].x * validHole[j].y;
            holeArea -= validHole[j].x * validHole[k].y;
        }
        if (holeArea > 0) validHole.reverse();

        const hole = new THREE.Path();
        validHole.forEach((v, j) => (j === 0 ? hole.moveTo(v.x, v.y) : hole.lineTo(v.x, v.y)));
        shape.holes.push(hole);
    }
    return shape;
}

// --- SPATIAL SORTING UTILITY ---
// Forces merged chunks to be geographically tight, allowing the GPU to 
// cleanly cull (hide) entire neighborhoods when you look away from them.
function spatialSort(geoArray) {
    geoArray.forEach(g => { if (!g.boundingSphere) g.computeBoundingSphere(); });
    geoArray.sort((a, b) => {
        // Group into 500m x 500m blocks
        const aX = Math.floor(a.boundingSphere.center.x / 500);
        const aZ = Math.floor(a.boundingSphere.center.z / 500);
        const bX = Math.floor(b.boundingSphere.center.x / 500);
        const bZ = Math.floor(b.boundingSphere.center.z / 500);
        
        if (aX !== bX) return aX - bX;
        return aZ - bZ;
    });
}

export async function chunkAndMerge(geoArray, mat, isLine, targetGroup) {
    if (geoArray.length === 0) return;
    spatialSort(geoArray);

    const CHUNK_SIZE = isLine ? 100 : 250;
    for (let i = 0; i < geoArray.length; i += CHUNK_SIZE) {
        const chunk = geoArray.slice(i, i + CHUNK_SIZE);

        for (const g of chunk) {
            for (const name of Object.keys(g.attributes)) {
                if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
            }
        }

        const hasIdx = chunk.some(g => g.index !== null);
        const hasNon = chunk.some(g => g.index === null);
        const toMerge = (hasIdx && hasNon)
            ? chunk.map(g => g.index !== null ? g.toNonIndexed() : g)
            : chunk;
        const mGeo = BufferGeometryUtils.mergeBufferGeometries(toMerge);
        if (toMerge !== chunk) toMerge.forEach((g, j) => { if (g !== chunk[j]) g.dispose(); });

        chunk.forEach(g => g.dispose());

        if (!mGeo) { await yieldThread(); continue; }

        let mMesh;
        if (isLine) {
            const lineGeo = new LineSegmentsGeometry();
            lineGeo.setPositions(mGeo.attributes.position.array);
            mGeo.dispose();
            mMesh = new LineSegments2(lineGeo, mat);
        } else {
            mMesh = new THREE.Mesh(mGeo, mat);
            mMesh.castShadow    = true;
            mMesh.receiveShadow = true;
        }

        mMesh.userData.isGhost = false;
        mMesh.matrixAutoUpdate = false;
        mMesh.updateMatrix();
        targetGroup.add(mMesh);
        await yieldThread();
    }
}

async function flushMerge(fills, wires, roofFills, roofWires, details, mats) {
    if (fills.length)     { await chunkAndMerge(fills,     mats.bldgFill, false, Engine.groups.bFill);  fills.length     = 0; }
    if (wires.length)     { await chunkAndMerge(wires,     mats.ctxLine,  true,  Engine.groups.bWire);  wires.length     = 0; }
    if (roofFills.length) { await chunkAndMerge(roofFills, mats.bldgFill, false, Engine.groups.roofs);  roofFills.length = 0; }
    if (roofWires.length) { await chunkAndMerge(roofWires, mats.ctxLine, true,  Engine.groups.roofs);  roofWires.length = 0; }
    if (details.length)   { await chunkAndMerge(details,   mats.ctxLine, true,  Engine.groups.detail); details.length   = 0; }
}

function douglasPeucker(pts, epsilon) {
    if (pts.length <= 2) return pts.slice();
    const first = pts[0], last = pts[pts.length - 1];
    const dx = last.x - first.x, dy = last.y - first.y;
    const chord = Math.sqrt(dx * dx + dy * dy);
    let maxDist = 0, maxIdx = 1;
    for (let i = 1; i < pts.length - 1; i++) {
        const d = chord > 1e-9
            ? Math.abs(dx * (first.y - pts[i].y) - (first.x - pts[i].x) * dy) / chord
            : Math.hypot(pts[i].x - first.x, pts[i].y - first.y);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
        const L = douglasPeucker(pts.slice(0, maxIdx + 1), epsilon);
        const R = douglasPeucker(pts.slice(maxIdx), epsilon);
        return [...L.slice(0, -1), ...R];
    }
    return [first, last];
}

function cleanAndResample(projPts, maxStep, groundFn) {
    if (projPts.length < 2) return [];
    const result = [];

    // 1. Strip degenerate micro-points to prevent normal twisting
    const cleanPts = [projPts[0]];
    for (let i = 1; i < projPts.length; i++) {
        if (Math.hypot(projPts[i].x - cleanPts[cleanPts.length-1].x, projPts[i].y - cleanPts[cleanPts.length-1].y) > 0.1) {
            cleanPts.push(projPts[i]);
        }
    }
    if (cleanPts.length < 2) return [];

    // 2. Resample while strictly preserving original OSM corners
    for (let i = 0; i < cleanPts.length - 1; i++) {
        const p1 = cleanPts[i];
        const p2 = cleanPts[i+1];

        const v1 = new THREE.Vector3(p1.x, 0, -p1.y);
        v1.y = groundFn(v1.x, v1.z);
        if (i === 0) result.push(v1);

        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (dist > maxStep) {
            const steps = Math.ceil(dist / maxStep);
            for (let j = 1; j < steps; j++) {
                const t = j / steps;
                const pt = new THREE.Vector3(p1.x + (p2.x - p1.x) * t, 0, -(p1.y + (p2.y - p1.y) * t));
                pt.y = groundFn(pt.x, pt.z);
                result.push(pt);
            }
        }
        const v2 = new THREE.Vector3(p2.x, 0, -p2.y);
        v2.y = groundFn(v2.x, v2.z);
        result.push(v2);
    }
    return result;
}

function buildVolumetricBridge(projPts, startY, endY, hOffset, halfW, taperStart, taperEnd, baseOffset = 0.3, markings = true) {
    // Deduplicate micro-points
    let cleanPts = [projPts[0]];
    for (let i = 1; i < projPts.length; i++) {
        if (Math.hypot(projPts[i].x - cleanPts[cleanPts.length-1].x, projPts[i].y - cleanPts[cleanPts.length-1].y) > 0.1) {
            cleanPts.push(projPts[i]);
        }
    }
    if (cleanPts.length < 2) return null;

    // Resample at uniform 2m steps
    const STEP = 2.0;
    const resampled = [new THREE.Vector3(cleanPts[0].x, 0, -cleanPts[0].y)];
    const resDists = [0];
    let resTotal = 0;

    for (let i = 0; i < cleanPts.length - 1; i++) {
        const p1 = cleanPts[i], p2 = cleanPts[i+1];
        const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const steps = Math.ceil(segDist / STEP);
        for (let j = 1; j <= steps; j++) {
            const s = j / steps;
            const pt = new THREE.Vector3(p1.x + (p2.x - p1.x) * s, 0, -(p1.y + (p2.y - p1.y) * s));
            resTotal += resampled[resampled.length-1].distanceTo(pt);
            resDists.push(resTotal);
            resampled.push(pt);
        }
    }
    
    // THE FIX: Short spans (catwalks) cannot taper to the ground without extreme slopes.
    // Force them to remain flat, elevated skybridges.
    if (resTotal < 35.0) {
        taperStart = false;
        taperEnd = false;
    }

    const deckThickness = 0.8;
    const groundYStart = startY + baseOffset;
    const groundYEnd   = endY   + baseOffset;
    const nominalStart = startY + hOffset;
    const nominalEnd   = endY   + hOffset;

    // Dynamic gradient ramp — calculate required ramp length from actual height delta
    // so the approach slope never exceeds MAX_GRADIENT (8% = realistic road/rail grade).
    // A fixed-distance ramp creates cliff-like grades when hOffset is large.
    const MAX_GRADIENT = 0.08;
    const deltaYStart = Math.abs(nominalStart - groundYStart);
    const deltaYEnd   = Math.abs(nominalEnd   - groundYEnd);
    const rampStart = Math.min(resTotal * 0.45, deltaYStart / MAX_GRADIENT);
    const rampEnd   = Math.min(resTotal * 0.45, deltaYEnd   / MAX_GRADIENT);
    // Guard: if both ramps would overlap, scale them equally to fit
    const rampScale = (rampStart + rampEnd > resTotal * 0.9)
        ? (resTotal * 0.9) / (rampStart + rampEnd)
        : 1.0;
    const RAMP_S = rampStart * rampScale;
    const RAMP_E = rampEnd   * rampScale;

    const pos = [], idx = [], roadUV = [], roadED = [];

    for (let i = 0; i < resampled.length; i++) {
        const pt = resampled[i];
        let fwd = new THREE.Vector2();
        if (i === 0) {
            fwd.set(resampled[1].x - pt.x, resampled[1].z - pt.z).normalize();
        } else if (i === resampled.length - 1) {
            fwd.set(pt.x - resampled[i-1].x, pt.z - resampled[i-1].z).normalize();
        } else {
            const d1 = new THREE.Vector2(pt.x - resampled[i-1].x, pt.z - resampled[i-1].z).normalize();
            const d2 = new THREE.Vector2(resampled[i+1].x - pt.x, resampled[i+1].z - pt.z).normalize();
            fwd.addVectors(d1, d2).normalize();
            if (fwd.lengthSq() < 0.001) fwd.copy(d1);
        }

        const nx = -fwd.y * halfW, nz = fwd.x * halfW;
        const rx = pt.x + nx, rz = pt.z + nz;
        const lx = pt.x - nx, lz = pt.z - nz;

        const dist        = resDists[i];
        const distFromEnd = resTotal - dist;
        const t           = resTotal > 0 ? dist / resTotal : 0;

        // Nominal deck height at this point (straight lerp start→end elevation)
        const nominalY = nominalStart + (nominalEnd - nominalStart) * t;
        // Ground-level reference at this point (lerped, same as road hover)
        const baseY    = groundYStart + (groundYEnd - groundYStart) * t;

        // Dynamic taper factors — each end uses its own ramp length derived from
        // actual height delta / MAX_GRADIENT, so the approach slope is always ≤8%.
        const sfRaw = taperStart ? Math.min(1.0, dist        / RAMP_S) : 1.0;
        const efRaw = taperEnd   ? Math.min(1.0, distFromEnd / RAMP_E) : 1.0;
        const sf = sfRaw * sfRaw * (3 - 2 * sfRaw);
        const ef = efRaw * efRaw * (3 - 2 * efRaw);
        const f  = Math.min(sf, ef);

        const deckY = baseY + (nominalY - baseY) * f;

        pt.y = deckY;
        const yBot = deckY - deckThickness;

        pos.push(rx, deckY, rz,  lx, deckY, lz,  rx, yBot, rz,  lx, yBot, lz);
        pos.push(rx, deckY, rz,  rx, yBot, rz,   lx, deckY, lz, lx, yBot, lz);

        // roadUV: 8 entries matching the 8 positions above.
        // Top deck face (v0,v1) drives the lane lines: U=0 right, U=1 left.
        // Side/bottom verts keep U=0/1 at their respective edges (no line there).
        const v  = resDists[i] / 4.0;
        const ed = markings ? Math.min(resDists[i], resTotal - resDists[i]) : 0.0;
        roadUV.push(0,v, 1,v, 0,v, 1,v);  // deck top + underside
        roadUV.push(0,v, 0,v, 1,v, 1,v);  // right edge + left edge
        for (let _v = 0; _v < 8; _v++) roadED.push(ed);
    }

    for (let i = 0; i < resampled.length - 1; i++) {
        const a = i * 8, b = (i + 1) * 8;
        idx.push(a+0, a+1, b+1,   a+0, b+1, b+0);
        idx.push(a+2, b+3, a+3,   a+2, b+2, b+3);
        idx.push(a+4, a+5, b+5,   a+4, b+5, b+4);
        idx.push(a+6, b+7, a+7,   a+6, b+6, b+7);
    }

    let deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    deckGeo.setAttribute('roadUV',   new THREE.Float32BufferAttribute(roadUV, 2));
    deckGeo.setAttribute('roadED',   new THREE.Float32BufferAttribute(roadED, 1));
    deckGeo.setIndex(idx);
    deckGeo.computeVertexNormals();

    // ── Pillar arrays ────────────────────────────────────────────────────────
    // Replace the single wide BoxGeometry slab with 2–3 round pillars spread
    // transversely across the deck, topped with a rectangular crossbeam cap.
    // Each pillar is also injected into SpatialGrid so the player collides with it.
    const pierGeos = [];
    const PIER_INTERVAL  = 30;       // place a bent every 30 m along the span
    const PILLAR_R       = 0.55;     // pillar radius (m)
    const PILLAR_SEGS    = 10;       // cylinder faces
    const BEAM_THICK     = 0.5;      // crossbeam height

    let distSincePier = 0;
    for (let i = 0; i < resampled.length - 1; i++) {
        const pA = resampled[i], pB = resampled[i + 1];
        distSincePier += pA.distanceTo(pB);
        if (distSincePier < PIER_INTERVAL) continue;
        distSincePier = 0;

        // Skip inside dynamic taper zones — deck is near grade there
        if ((taperStart && resDists[i] < RAMP_S) || (taperEnd && (resTotal - resDists[i]) < RAMP_E)) continue;

        const groundY = getElevationAt(pA.x, pA.z);
        const deckTop = pA.y;
        const pierH   = (deckTop - deckThickness) - groundY + 0.5;
        if (pierH < 0.8) continue;

        // Transverse direction (right-perpendicular of forward)
        const fwdX = pB.x - pA.x, fwdZ = pB.z - pA.z;
        const fwdLen = Math.hypot(fwdX, fwdZ) || 1;
        const tX = -fwdZ / fwdLen;   // transverse unit vector X
        const tZ =  fwdX / fwdLen;   // transverse unit vector Z

        // 2 pillars for narrow bridges, 3 for wide ones
        const pillarCount = halfW >= 4.5 ? 3 : 2;
        const spread      = halfW * 0.72; // total spread of pillar group

        const pillarCentreY = groundY + pierH * 0.5;
        const beamY         = groundY + pierH - BEAM_THICK * 0.5;

        for (let p = 0; p < pillarCount; p++) {
            const frac  = pillarCount === 1 ? 0 : (p / (pillarCount - 1)) - 0.5;
            const offX  = pA.x + tX * (frac * spread * 2);
            const offZ  = pA.z + tZ * (frac * spread * 2);

            // Cylinder pillar
            const cyl = new THREE.CylinderGeometry(PILLAR_R, PILLAR_R * 1.15, pierH, PILLAR_SEGS);
            cyl.translate(offX, pillarCentreY, offZ);
            cyl.deleteAttribute('uv');
            pierGeos.push(cyl);

            // Inject pillar as a vertical bridge segment for collision
            injectBridgeSegmentToGrid(
                { x: offX, y: groundY,  z: offZ },
                { x: offX, y: deckTop,  z: offZ },
                PILLAR_R + 0.15
            );
        }

        // Crossbeam spanning all pillars — box along transverse axis, rotated to match
        const beamLen = spread * 2 + PILLAR_R * 2;
        const beam = new THREE.BoxGeometry(beamLen, BEAM_THICK, PILLAR_R * 2);
        beam.rotateY(Math.atan2(tX, tZ)); // align with transverse direction
        beam.translate(pA.x, beamY, pA.z);
        beam.deleteAttribute('uv');
        pierGeos.push(beam);
    }

    let pierGeo = null;
    if (pierGeos.length > 0) {
        pierGeo = BufferGeometryUtils.mergeBufferGeometries(pierGeos);
        pierGeos.forEach(p => p.dispose());
        // Zero-fill roadUV/roadED so pier geo matches deck/polygon geo attribute layout.
        // Zero U puts all pier verts far from the line centre — no lines drawn.
        const pierCount = pierGeo.attributes.position.count;
        pierGeo.setAttribute('roadUV', new THREE.Float32BufferAttribute(new Float32Array(pierCount * 2), 2));
        pierGeo.setAttribute('roadED', new THREE.Float32BufferAttribute(new Float32Array(pierCount),     1));
    }

    for (let i = 0; i < resampled.length - 1; i++) {
        injectBridgeSegmentToGrid(resampled[i], resampled[i + 1], halfW);
    }

    return { deckGeo, pierGeo };
}

// ============================================================================
// VOLUMETRIC TUNNEL BUILDER
// ----------------------------------------------------------------------------
// Produces a 4-wall closed tube (floor + ceiling + L wall + R wall) following
// the terrain contour at a fixed depth. Terrain-sampled depth naturally handles
// Chongqing's mountain-ridge tunnels without the tube emerging above ground.
//
// Portal ramps at each tapered end transition the floor from ground level down
// to full tunnel depth over a RAMP distance, and register a portal hole so the
// topo shader discards the terrain mesh at the entrance (shared with physics).
//
// Returns { tubeGeo, stripGeo, portalGeo }:
//   tubeGeo   — merged 4-wall tube geometry (DoubleSide concrete material)
//   stripGeo  — emissive ceiling light strips (MeshBasicMaterial, zero-cost)
//   portalGeo — portal frame geometry at tube mouths
// ============================================================================
// nodeStartIsTunnel / nodeEndIsTunnel: true when the endpoint connects to
// another tunnel segment. Suppresses end caps at those joints so adjacent
// tube geometries merge into a continuous bore with no internal walls.
function buildVolumetricTunnel(projPts, halfW, clearance, depthOffset, taperStart, taperEnd, nodeStartIsTunnel = false, nodeEndIsTunnel = false) {
    // Deduplicate micro-points
    let cleanPts = [projPts[0]];
    for (let i = 1; i < projPts.length; i++) {
        if (Math.hypot(projPts[i].x - cleanPts[cleanPts.length-1].x, projPts[i].y - cleanPts[cleanPts.length-1].y) > 0.1) {
            cleanPts.push(projPts[i]);
        }
    }
    if (cleanPts.length < 2) return null;

    // Resample at uniform 2m steps (same as bridge builder for visual consistency)
    const STEP = 2.0;
    const resampled = [new THREE.Vector3(cleanPts[0].x, 0, -cleanPts[0].y)];
    const resDists = [0];
    let resTotal = 0;

    for (let i = 0; i < cleanPts.length - 1; i++) {
        const p1 = cleanPts[i], p2 = cleanPts[i+1];
        const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const steps = Math.ceil(segDist / STEP);
        for (let j = 1; j <= steps; j++) {
            const s = j / steps;
            const pt = new THREE.Vector3(p1.x + (p2.x - p1.x) * s, 0, -(p1.y + (p2.y - p1.y) * s));
            resTotal += resampled[resampled.length-1].distanceTo(pt);
            resDists.push(resTotal);
            resampled.push(pt);
        }
    }

    if (resampled.length < 2 || resTotal < 1.0) return null;

    // Dynamic gradient ramp — depth at each portal / MAX_GRADIENT gives the
    // exact distance needed to stay ≤8% grade. Fixed ramps fail on deep tunnels.
    const MAX_GRADIENT = 0.08;
    const RAMP_S = taperStart
        ? Math.min(resTotal * 0.45, depthOffset / MAX_GRADIENT)
        : 0;
    const RAMP_E = taperEnd
        ? Math.min(resTotal * 0.45, depthOffset / MAX_GRADIENT)
        : 0;
    // If both ramps would together exceed the tunnel length, scale them down equally
    const rampFit = (RAMP_S + RAMP_E > resTotal * 0.9 && RAMP_S + RAMP_E > 0)
        ? (resTotal * 0.9) / (RAMP_S + RAMP_E)
        : 1.0;
    const RAMP = Math.max(RAMP_S, RAMP_E) * rampFit; // kept for portal hole radius below

    // Per-cross-section data: nominalFloorY = terrainHere - depthOffset,
    // then taper-lerp toward the surface at portal endpoints.
    // We compute the floor y per vertex (mutating resampled[i].y) so the grid
    // injection below uses the exact same values as the rendered geometry.
    const floorYs   = new Float32Array(resampled.length);
    const surfaceYs = new Float32Array(resampled.length);
    const taperFs   = new Float32Array(resampled.length); // 0 at portal, 1 at depth

    const sfR = RAMP_S * rampFit;
    const efR = RAMP_E * rampFit;

    for (let i = 0; i < resampled.length; i++) {
        const pt = resampled[i];

        const dist        = resDists[i];
        const distFromEnd = resTotal - dist;

        // Taper factor f: 0 at portal mouth, 1 at full depth.
        const sf = (taperStart && sfR > 0) ? Math.min(1.0, dist        / sfR) : 1.0;
        const ef = (taperEnd   && efR > 0) ? Math.min(1.0, distFromEnd / efR) : 1.0;
        const f  = Math.min(sf, ef);
        taperFs[i] = f;

        // Rigorous terrain sampling for mathematical boundary conditions
        const elevFn = getElevationAt;
        const tC = elevFn(pt.x, pt.z); // No layer offset

        let terrainHere;
        if (f < 0.999) {
            // In ramp zone: sample a 3x3 grid around the point
            const samples = [
                elevFn(pt.x + halfW, pt.z),
                elevFn(pt.x - halfW, pt.z),
                elevFn(pt.x, pt.z + halfW),
                elevFn(pt.x, pt.z - halfW),
                elevFn(pt.x + halfW * 0.7, pt.z + halfW * 0.7),
                elevFn(pt.x - halfW * 0.7, pt.z + halfW * 0.7),
                elevFn(pt.x + halfW * 0.7, pt.z - halfW * 0.7),
                elevFn(pt.x - halfW * 0.7, pt.z - halfW * 0.7)
            ];
            terrainHere = Math.max(tC, ...samples);

            // Additional safety margin for very steep slopes
            const slopeCheck = Math.abs(elevFn(pt.x + 2, pt.z) - elevFn(pt.x - 2, pt.z)) / 4;
            if (slopeCheck > 0.5) {
                terrainHere += slopeCheck * 0.5;
            }
        } else {
            terrainHere = tC;
        }

        surfaceYs[i] = terrainHere;
        const nominalFloorY = terrainHere - depthOffset;

        // Floor: taper from terrain surface to full depth.
        floorYs[i] = terrainHere - 0.05 + (nominalFloorY - terrainHere) * f;
        pt.y = floorYs[i];
    }

    // ── Geometry construction ──────────────────────────────────────────────
    // 8 vertices per cross-section: 4 for the tube (floor L/R, ceiling L/R),
    // plus 4 duplicated with opposite normals isn't needed — we use DoubleSide.
    // Vertex layout per section (base index = i * 4):
    //   +0  right-floor    +1  left-floor    +2  right-ceiling   +3  left-ceiling
    const pos = [], idx = [];

    for (let i = 0; i < resampled.length; i++) {
        const pt = resampled[i];
        const fy = floorYs[i];
        // Ceiling calculation with rigorous mathematical boundary conditions
        // to prevent slope tearing and missing ceilings:
        // 1. Full clearance at depth: cy = fy + clearance
        // 2. In ramp zone: smoothly interpolate between terrain-clamped and full clearance
        // 3. Minimum ceiling height: fy + 1.0 (absolute minimum for any tunnel)
        // 4. Terrain clearance: surfaceYs[i] - 0.3 (more generous buffer)
        const cyCandid = fy + clearance;
        let cy;
        if (taperFs[i] >= 0.999) {
            cy = cyCandid; // full clearance, no clamp needed
        } else {
            // Smooth interpolation between terrain-clamped and full clearance
            // using taperFs as interpolation factor (0 at portal, 1 at depth)
            const terrainClamped = Math.min(cyCandid, surfaceYs[i] - 0.3);
            const minCeiling = fy + 1.0;
            const targetCeiling = Math.max(minCeiling, terrainClamped);
            
            // Smooth transition: at portal (taperFs=0) use terrain-clamped,
            // at depth (taperFs=1) use full clearance
            const t = taperFs[i]; // 0 to 1
            const smoothT = t * t * (3 - 2 * t); // smoothstep interpolation
            cy = targetCeiling + (cyCandid - targetCeiling) * smoothT;
            
            // Final safety clamp
            cy = Math.max(minCeiling, Math.min(cy, cyCandid));
        }

        // Forward tangent (2D) — averaged at interior points for smoothness
        let fwdX, fwdZ;
        if (i === 0) {
            fwdX = resampled[1].x - pt.x;
            fwdZ = resampled[1].z - pt.z;
        } else if (i === resampled.length - 1) {
            fwdX = pt.x - resampled[i-1].x;
            fwdZ = pt.z - resampled[i-1].z;
        } else {
            const d1x = pt.x - resampled[i-1].x, d1z = pt.z - resampled[i-1].z;
            const d2x = resampled[i+1].x - pt.x, d2z = resampled[i+1].z - pt.z;
            const l1 = Math.hypot(d1x, d1z) || 1;
            const l2 = Math.hypot(d2x, d2z) || 1;
            fwdX = (d1x / l1 + d2x / l2);
            fwdZ = (d1z / l1 + d2z / l2);
        }
        const fwdLen = Math.hypot(fwdX, fwdZ) || 1;
        fwdX /= fwdLen; fwdZ /= fwdLen;

        // Right-perpendicular × halfW → cross-section endpoint offsets
        const nx = -fwdZ * halfW, nz = fwdX * halfW;
        const rx = pt.x + nx, rz = pt.z + nz;
        const lx = pt.x - nx, lz = pt.z - nz;

        pos.push(
            rx, fy, rz,  // +0 right-floor
            lx, fy, lz,  // +1 left-floor
            rx, cy, rz,  // +2 right-ceiling
            lx, cy, lz,  // +3 left-ceiling
        );
    }

    // Build the 4 interior faces between adjacent cross-sections.
    // Winding is set to face INWARD (toward the tube axis) so with DoubleSide
    // material, both interior and exterior rendering look correct. Using
    // DoubleSide is acceptable here because underground lighting is indirect
    // (fog + emissive + ambient) — normal direction is nearly invisible.
    for (let i = 0; i < resampled.length - 1; i++) {
        const a = i * 4, b = (i + 1) * 4;

        // Ceiling (+2, +3): visible from below — always rendered
        idx.push(a + 2, b + 3, a + 3,   a + 2, b + 2, b + 3);
        // Floor (+0, +1): visible from above
        idx.push(a + 0, a + 1, b + 1,   a + 0, b + 1, b + 0);
        // Right wall (+0, +2): visible from inside
        idx.push(a + 0, b + 0, b + 2,   a + 0, b + 2, a + 2);
        // Left wall (+1, +3): visible from inside
        idx.push(a + 1, b + 3, b + 1,   a + 1, a + 3, b + 3);
    }

    // End caps — close the tube mouth when the endpoint has no neighbour to
    // connect to. Suppress caps at:
    //   - tapered portals (the ramp geometry is the visual transition)
    //   - tunnel-to-tunnel junctions (adjacent tube fills the opening)
    if (!taperStart && !nodeStartIsTunnel) {
        const a = 0;
        idx.push(a + 0, a + 2, a + 3,   a + 0, a + 3, a + 1);
    }
    if (!taperEnd && !nodeEndIsTunnel) {
        const a = (resampled.length - 1) * 4;
        idx.push(a + 0, a + 3, a + 2,   a + 0, a + 1, a + 3);
    }

    const tubeGeo = new THREE.BufferGeometry();
    tubeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tubeGeo.setIndex(idx);
    tubeGeo.computeVertexNormals();

    // ── Emissive ceiling strips — one strip every ~20m along the tube ──────
    // Skip for open-sided structures (covered walkways) — no interior to light.
    const stripGeos = [];
    let distSinceStrip = 10.0; // offset so strips aren't flush with portals
    const STRIP_INTERVAL = 20.0;
    const STRIP_LEN = 4.0;
    const STRIP_WIDTH = 0.35;
    const STRIP_THICK = 0.08;

    for (let i = 0; i < resampled.length - 1; i++) {
        const pA = resampled[i], pB = resampled[i+1];
        const segLen = pA.distanceTo(pB);
        distSinceStrip += segLen;
        if (distSinceStrip >= STRIP_INTERVAL) {
            distSinceStrip = 0;

            // Skip strips too close to tapered endpoints — ramp zone is where
            // ambient surface light bleeds in anyway
            if ((taperStart && resDists[i] < RAMP * 0.8) || (taperEnd && (resTotal - resDists[i]) < RAMP * 0.8)) continue;

            const fwdX = (pB.x - pA.x) / segLen;
            const fwdZ = (pB.z - pA.z) / segLen;
            const ceilY = floorYs[i] + clearance - STRIP_THICK * 0.5 - 0.05;

            const sGeo = new THREE.BoxGeometry(STRIP_LEN, STRIP_THICK, STRIP_WIDTH);
            sGeo.rotateY(Math.atan2(fwdX, fwdZ));
            sGeo.translate(pA.x, ceilY, pA.z);
            sGeo.deleteAttribute('uv');
            sGeo.deleteAttribute('normal'); // MeshBasicMaterial doesn't need them
            stripGeos.push(sGeo);
        }
    }
    let stripGeo = null;
    if (stripGeos.length > 0) {
        stripGeo = BufferGeometryUtils.mergeBufferGeometries(stripGeos);
        stripGeos.forEach(g => g.dispose());
    }

    // ── Portal holes & entrance collars ─────────────────
    const portalGeos = [];

    // Deep tunnels: only build concrete entrance collars (pure geometry).
    // No registerPortalHole — deep tunnels are underground and don't intersect buildings.
    for (const idx of [0, resampled.length - 1]) {
        const shouldBuild = (idx === 0 && taperStart) || (idx === resampled.length - 1 && taperEnd);
        if (!shouldBuild) continue;

        const pt = resampled[idx];
        let fwdX, fwdZ;
        if (idx === 0) { fwdX = resampled[1].x - pt.x; fwdZ = resampled[1].z - pt.z; }
        else { fwdX = pt.x - resampled[idx-1].x; fwdZ = pt.z - resampled[idx-1].z; }
        const fl = Math.hypot(fwdX, fwdZ) || 1;
        fwdX /= fl; fwdZ /= fl;

        const collarW = halfW * 4.0;
        const collarH = clearance * 2.0;
        const collarGeo = new THREE.PlaneGeometry(collarW, collarH);
        const angle = Math.atan2(-fwdZ, fwdX) + (idx === 0 ? Math.PI : 0);
        collarGeo.rotateY(angle);
        collarGeo.translate(pt.x, floorYs[idx] + collarH * 0.5 - 0.5, pt.z);
        collarGeo.deleteAttribute('uv');
        portalGeos.push(collarGeo);
    }

    let portalGeo = null;
    if (portalGeos.length > 0) {
        portalGeo = BufferGeometryUtils.mergeBufferGeometries(portalGeos);
        portalGeos.forEach(g => g.dispose());
    }

    // ── Inject segments into the spatial grid for physics ──────────────────
    for (let i = 0; i < resampled.length - 1; i++) {
        injectTunnelSegmentToGrid(resampled[i], resampled[i+1], halfW, clearance);
    }

    return { tubeGeo, stripGeo, portalGeo };
}

function buildSmoothRibbon(pts, halfWidth, markings = true) {
    if (pts.length < 2) return null;
    const pos = [], idx = [], uv = [], ed = [];
    let lastTx = 1, lastTz = 0, dist = 0;

    // Pre-compute total length so we can derive distance-from-end per vertex.
    let totalDist = 0;
    for (let i = 1; i < pts.length; i++) totalDist += Math.hypot(pts[i].x - pts[i-1].x, pts[i].z - pts[i-1].z);

    for (let i = 0; i < pts.length; i++) {
        const prev = pts[i > 0 ? i - 1 : 0];
        const next = pts[i < pts.length - 1 ? i + 1 : pts.length - 1];

        // Accumulate longitudinal distance for V coordinate
        if (i > 0) {
            dist += Math.hypot(pts[i].x - pts[i-1].x, pts[i].z - pts[i-1].z);
        }

        let tx = next.x - prev.x, tz = next.z - prev.z;
        const len = Math.hypot(tx, tz);
        if (len < 1e-5) { tx = lastTx; tz = lastTz; }
        else { tx /= len; tz /= len; lastTx = tx; lastTz = tz; }

        const nx = -tz * halfWidth, nz = tx * halfWidth;
        const rightX = pts[i].x + nx, rightZ = pts[i].z + nz;
        const leftX  = pts[i].x - nx, leftZ  = pts[i].z - nz;

        let rightY, leftY;
        if (pts[i].isBridgeDeck) {
            rightY = leftY = pts[i].y;
        } else {
            const rBase = getElevationAt(rightX, rightZ);
            const lBase = getElevationAt(leftX, leftZ);
            const cBase = getElevationAt(pts[i].x, pts[i].z);

            // THE FIX: Let the road twist to naturally bank with the terrain slope.
            const targetOffset = pts[i].y - cBase;
            // Use a "ridge push" to mathematically guarantee the center doesn't clip on convex hills.
            const ridgePush = Math.max(0, cBase - (rBase + lBase) / 2);

            rightY = rBase + targetOffset + ridgePush;
            leftY  = lBase + targetOffset + ridgePush;
        }

        const v   = dist / 4.0; // 4m per UV tile — controls dash spacing
        // Edge distance: 0 on footpaths/unmarked roads (permanently faded),
        // otherwise min(dist-from-start, dist-from-end) in metres.
        const edV = markings ? Math.min(dist, totalDist - dist) : 0.0;
        pos.push(rightX, rightY, rightZ);  uv.push(0.0, v);  ed.push(edV);
        pos.push(leftX,  leftY,  leftZ);   uv.push(1.0, v);  ed.push(edV);
    }

    for (let i = 0; i < pts.length - 1; i++) {
        const a = i * 2;
        idx.push(a, a+1, a+2,  a+1, a+3, a+2);
    }

    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('roadUV',   new THREE.Float32BufferAttribute(uv,  2));
    geo.setAttribute('roadED',   new THREE.Float32BufferAttribute(ed,  1));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    return geo;
}

// --- STAIRCASE GEOMETRY WITH DYNAMIC ALTITUDE ANCHORING ---
// Creates staircase geometry with proper Z-Line check for vertical traversal
// Implements dynamic altitude anchoring based on bridge/terrain structures
function buildStaircase(projPts, halfW) {
    if (projPts.length < 2) return null;
    
    // DYNAMIC ALTITUDE ANCHORING (Z-Line Check)
    // Query start and end nodes against spatial grid to determine precise Y elevations
    const startPt = projPts[0];
    const endPt = projPts[projPts.length - 1];
    
    let startY, endY;
    
    // Check start node for bridge or bridgePoly structures
    const startHits = getStructureAt(startPt.x, -startPt.y);
    const bridgeHit = startHits.find(h => h.type === 'bridge' || h.type === 'bridgePoly');
    if (bridgeHit) {
        // Start is on a bridge - use bridge yTop
        startY = bridgeHit.yTop;
    } else {
        // Start is on terrain - use terrain elevation
        startY = getElevationAt(startPt.x, -startPt.y) + 0.3; // +0.3m for road surface
    }
    
    // Check end node
    const endHits = getStructureAt(endPt.x, -endPt.y);
    const endBridgeHit = endHits.find(h => h.type === 'bridge' || h.type === 'bridgePoly');
    if (endBridgeHit) {
        // End is on a bridge - use bridge yTop
        endY = endBridgeHit.yTop;
    } else {
        // End is on terrain - use terrain elevation
        endY = getElevationAt(endPt.x, -endPt.y) + 0.3; // +0.3m for road surface
    }
    
    // Calculate deltaY and total 2D distance
    const deltaY = endY - startY;
    const total2DDist = projPts.reduce((sum, pt, i) => {
        if (i === 0) return 0;
        return sum + Math.hypot(pt.x - projPts[i-1].x, pt.y - projPts[i-1].y);
    }, 0);
    
    // STAIRCASE EXTRUSION GEOMETRY
    // Create solid block geometry that traverses deltaY linearly over 2D distance
    const pos = [], idx = [], uv = [], ed = [];
    const sections = [];
    
    // Generate cross-sections along the path
    for (let i = 0; i < projPts.length; i++) {
        const pt = projPts[i];
        const progress = i / (projPts.length - 1);
        const currentY = startY + deltaY * progress;
        
        // Calculate forward direction for cross-section orientation
        let fwdX, fwdZ;
        if (i === 0) {
            fwdX = projPts[1].x - pt.x;
            fwdZ = projPts[1].y - pt.y;
        } else if (i === projPts.length - 1) {
            fwdX = pt.x - projPts[i-1].x;
            fwdZ = pt.y - projPts[i-1].y;
        } else {
            fwdX = (projPts[i+1].x - projPts[i-1].x) / 2;
            fwdZ = (projPts[i+1].y - projPts[i-1].y) / 2;
        }
        
        const fwdLen = Math.hypot(fwdX, fwdZ) || 1;
        fwdX /= fwdLen;
        fwdZ /= fwdLen;
        
        // Right-perpendicular for cross-section
        const nx = -fwdZ * halfW;
        const nz = fwdX * halfW;
        
        // Create 4 vertices for this cross-section (bottom-left, bottom-right, top-left, top-right)
        const bottomHeight = 0.5; // Solid block thickness below stairs
        sections.push({
            bl: { x: pt.x - nx, z: -pt.y - nz, y: currentY - bottomHeight },
            br: { x: pt.x + nx, z: -pt.y + nz, y: currentY - bottomHeight },
            tl: { x: pt.x - nx, z: -pt.y - nz, y: currentY },
            tr: { x: pt.x + nx, z: -pt.y + nz, y: currentY }
        });
    }
    
    // Build vertex positions, UVs, and edge distances
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        
        // Calculate UV coordinates based on progress along the staircase
        const uProgress = i / (sections.length - 1);
        const vCoord = uProgress * total2DDist / 4.0; // Similar scaling to buildSmoothRibbon
        
        // Stairs have no markings, so edge distance is 0
        const edgeDist = 0.0;
        
        // Bottom-left vertex
        pos.push(s.bl.x, s.bl.y, s.bl.z);
        uv.push(0.0, vCoord);
        ed.push(edgeDist);
        
        // Bottom-right vertex
        pos.push(s.br.x, s.br.y, s.br.z);
        uv.push(1.0, vCoord);
        ed.push(edgeDist);
        
        // Top-left vertex
        pos.push(s.tl.x, s.tl.y, s.tl.z);
        uv.push(0.0, vCoord);
        ed.push(edgeDist);
        
        // Top-right vertex
        pos.push(s.tr.x, s.tr.y, s.tr.z);
        uv.push(1.0, vCoord);
        ed.push(edgeDist);
    }
    
    // Build triangles between sections
    for (let i = 0; i < sections.length - 1; i++) {
        const a = i * 4;
        const b = (i + 1) * 4;
        
        // Bottom face
        idx.push(a, a+1, b+1, a, b+1, b);
        // Top face (stairs surface)
        idx.push(a+2, b+3, a+3, a+2, b+2, b+3);
        // Right side
        idx.push(a+1, b+1, b+3, a+1, b+3, a+3);
        // Left side
        idx.push(a, b, b+2, a, b+2, a+2);
        // Front face (for start section)
        if (i === 0) {
            idx.push(a, a+2, a+3, a, a+3, a+1);
        }
        // Back face (for end section)
        if (i === sections.length - 2) {
            idx.push(b, b+1, b+3, b, b+3, b+2);
        }
    }
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('roadUV', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('roadED', new THREE.Float32BufferAttribute(ed, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    
    return geo;
}

// --- ROAD ELEVATION SMOOTHER ---
// Averages the Y-coordinates of a line segment array to turn sheer
// cliffs (like roof-snapping) into smooth, drivable ramps.
function smoothElevations(pts, passes = 3) {
    if (pts.length < 3) return pts;
    for (let p = 0; p < passes; p++) {
        const newY = new Float32Array(pts.length);
        newY[0] = pts[0].y;
        newY[pts.length - 1] = pts[pts.length - 1].y;
        for (let i = 1; i < pts.length - 1; i++) {
            newY[i] = (pts[i - 1].y + pts[i].y + pts[i + 1].y) / 3.0;
        }
        for (let i = 1; i < pts.length - 1; i++) {
            pts[i].y = newY[i];
        }
    }
    return pts;
}

function buildVerticalWall(pts, height) {
    if (pts.length < 2) return null;
    const pos = [], idx = [], uv = [], ed = [];
    
    // Calculate total distance for UV mapping
    let totalDist = 0;
    for (let i = 1; i < pts.length; i++) {
        totalDist += Math.hypot(pts[i].x - pts[i-1].x, pts[i].z - pts[i-1].z);
    }
    
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        
        // Accumulate distance for V coordinate
        if (i > 0) {
            dist += Math.hypot(p.x - pts[i-1].x, p.z - pts[i-1].z);
        }
        
        const v = dist / 4.0; // Same UV scaling as buildSmoothRibbon
        const edgeDist = 0.0; // Walls have no edge markings
        
        // Bottom vertex
        pos.push(p.x, p.y, p.z);
        uv.push(0.0, v);
        ed.push(edgeDist);
        
        // Top vertex
        pos.push(p.x, p.y + height, p.z);
        uv.push(1.0, v);
        ed.push(edgeDist);
    }
    
    for (let i = 0; i < pts.length - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2,   a + 1, a + 3, a + 2);
    }
    
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('roadUV', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('roadED', new THREE.Float32BufferAttribute(ed, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    
    return geo;
}

function getRoadHalfWidth(props) {
    if (props.width) {
        const w = parseFloat(props.width);
        if (!isNaN(w) && w > 0) return w / 2.0;
    }
    if (props.lanes) {
        const l = parseInt(props.lanes, 10);
        if (!isNaN(l) && l > 0) return (l * 3.5) / 2.0;
    }
    const h = (props.highway || '').toLowerCase();
    // For oneway roads without explicit width/lanes, the OSM way represents only
    // one direction of a dual carriageway. Use per-carriageway widths (roughly half
    // the full road) so the two parallel bores don't interpenetrate.
    const isOneway = props.oneway === 'yes' || props.oneway === '-1';
    switch (h) {
        case 'motorway': case 'trunk': return isOneway ? 3.5 : 6.0;
        case 'primary': return isOneway ? 3.0 : 5.0;
        case 'secondary': return isOneway ? 2.5 : 4.0;
        case 'tertiary': return 3.0;
        case 'residential': case 'unclassified': case 'road': return 2.5;
        case 'living_street': case 'service': return 1.5;
        case 'pedestrian': case 'footway': case 'cycleway': case 'path': return 1.0;
        case 'steps': return 1.5;
        default: return 1.5;
    }
}

function getOSMColor(colorStr, defaultHex) {
    if (!colorStr) return defaultHex;
    const s = colorStr.toLowerCase().trim();
    const map = {
        'brick': 0x8c4a32, 'brown': 0xa52a2a, 'red': 0xcc0000,
        'white': 0xffffff, 'grey': 0x808080, 'gray': 0x808080,
        'black': 0x222222, 'blue': 0x0044cc, 'green': 0x008000,
        'yellow': 0xffd700, 'orange': 0xff8c00, 'beige': 0xf5f5dc,
        'glass': 0x88ccff, 'silver': 0xc0c0c0, 'concrete': 0x999999
    };
    if (map[s]) return map[s];
    if (s.startsWith('#')) {
        const parsed = parseInt(s.replace('#', ''), 16);
        return isNaN(parsed) ? defaultHex : parsed;
    }
    return defaultHex;
}

function applyVertexColors(geo, hexColor) {
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color(hexColor);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}


function buildPolygonLayer(data, targetGroup, yOffset, extrudeDepth, matFill, colorKeyFn = null, matLine = null, elevFn = getElevationAt) {
    if (!data?.features) return;
    const fillBuckets = new Map(); 
    const lineBuckets = new Map(); 

    const yOffFn = typeof yOffset === 'function' ? yOffset : () => yOffset;
    const depthFn = typeof extrudeDepth === 'function' ? extrudeDepth : () => extrudeDepth;

    for (const feature of data.features) {
        if (!feature.geometry) continue;
        const key = colorKeyFn ? colorKeyFn(feature) : 'default';
        if (!fillBuckets.has(key)) {
            fillBuckets.set(key, []);
            lineBuckets.set(key, []);
        }

        const fYOff  = yOffFn(feature);
        const fDepth = depthFn(feature);

        for (const ring of getRings(feature.geometry)) {
            const shape = buildShape(ring);
            if (!shape || shape.curves.length === 0) continue;

            let geo = fDepth > 0
                ? new THREE.ExtrudeGeometry(shape, { depth: fDepth, bevelEnabled: false, curveSegments: 1 })
                : new THREE.ShapeGeometry(shape, 24);

            geo.rotateX(-Math.PI / 2);

            const pos = geo.attributes.position;
            for (let vi = 0; vi < pos.count; vi++) {
                const vx = pos.getX(vi);
                const vz = pos.getZ(vi);
                const vy = pos.getY(vi);
                const terrainY = elevFn(vx, vz);
                pos.setY(vi, terrainY + fYOff + vy);
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();

            fillBuckets.get(key).push(geo);

            if (matLine) {
                const edgeGeo = new THREE.EdgesGeometry(geo, 30);
                lineBuckets.get(key).push(edgeGeo);
            }
        }
    }

    for (const [key, geos] of fillBuckets) {
        if (geos.length === 0) continue;
        const before = targetGroup.children.length;
        chunkAndMerge(geos, plinthClone(matFill), false, targetGroup);
        for (let i = before; i < targetGroup.children.length; i++) {
            targetGroup.children[i].userData.colorKey = key;
        }
    }

    if (matLine) {
        for (const [key, geos] of lineBuckets) {
            if (geos.length === 0) continue;
            const before = targetGroup.children.length;
            chunkAndMerge(geos, plinthClone(matLine), true, targetGroup);
            for (let i = before; i < targetGroup.children.length; i++) {
                targetGroup.children[i].userData.colorKey = key;
            }
        }
    }
}

function parkColorKey(feature) {
    const l = (feature.properties || {}).leisure;
    if (l === 'nature_reserve') return 'nature_reserve';
    if (l === 'stadium' || l === 'sports_centre') return 'stadium';
    if (l === 'pitch' || l === 'track' || l === 'golf_course' ||
        l === 'miniature_golf' || l === 'disc_golf_course') return 'pitch';
    return 'park';
}

function vegColorKey(feature) {
    const p   = feature.properties || {};
    const nat = p.natural;
    const lu  = p.landuse;
    if (nat === 'wood' || lu === 'forest') return 'forest';
    if (nat === 'bare_rock' || nat === 'cliff') return 'terrain';
    if (nat === 'sand' || nat === 'beach' || nat === 'dune') return 'sand';
    if (nat === 'scrub' || nat === 'heath' || nat === 'wetland') return 'scrub';
    if (lu === 'farmland' || lu === 'orchard' || lu === 'vineyard') return 'farmland';
    if (lu === 'grass' || lu === 'meadow' || lu === 'greenfield' ||
        nat === 'grassland' || nat === 'fell' || nat === 'moor' || nat === 'tundra') return 'grass';
    return 'veg';
}

function hardscapeColorKey(feature) {
    const p = feature.properties || {};
    if (p.amenity === 'parking') return 'parking';
    if (p.aeroway) return 'aeroway';
    if (p.highway === 'pedestrian') return 'plaza';
    return null;
}

function zoningColorKey(feature) {
    const p  = feature.properties || {};
    const lu = p.landuse;
    const am = p.amenity;
    if (am === 'university' || am === 'college' || am === 'school' ||
        am === 'hospital'   || am === 'clinic') return 'institutional';
    if (lu === 'residential') return 'residential';
    if (lu === 'commercial' || lu === 'retail') return 'commercial';
    if (lu === 'industrial'  || lu === 'quarry' || lu === 'brownfield' ||
        lu === 'construction'|| lu === 'landfill'|| lu === 'port') return 'industrial';
    if (lu === 'cemetery')  return 'cemetery';
    if (lu === 'military' || p.military) return 'military';
    return 'institutional';
}

function bakeTerrainTexture(zData, pData, vData, wData, skiData, hData, radius, theme) {
    const maxHwSize = Engine.renderer.capabilities.maxTextureSize;
    const targetSize = Engine.highResGround ? 32768 : 8192;
    const SIZE = Math.min(targetSize, maxHwSize);

    console.log(`[Texture Baker] Generating ground layer at ${SIZE}x${SIZE}px (GPU Max: ${maxHwSize})`);

    const canvas = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#' + new THREE.Color(theme.topo).getHexString();
    ctx.fillRect(0, 0, SIZE, SIZE);

    const drawLayer = (data, colorKeyFn, defaultColorHex) => {
        if (!data?.features) return;
        data.features.forEach(feature => {
            if (!feature.geometry) return;

            // Strict polygon-only guard — Points and lines are never baked.
            const gt = feature.geometry.type;
            if (gt !== 'Polygon' && gt !== 'MultiPolygon') return;

            const cKey = colorKeyFn ? colorKeyFn(feature) : null;
            const hex  = cKey ? theme[cKey] : defaultColorHex;
            if (hex === undefined || hex === null) return;

            ctx.fillStyle = '#' + new THREE.Color(hex).getHexString();

            ctx.beginPath();

            const coordsArray = gt === 'Polygon'
                ? [feature.geometry.coordinates]
                : feature.geometry.coordinates;

            coordsArray.forEach(path => {
                path.forEach(points => {
                    if (!points || points.length < 2) return;

                    let firstPx = null, lastPx = null;

                    points.forEach(pt => {
                        const proj = project(pt[0], pt[1]);
                        if (!proj.valid) return;
                        const px = ((proj.x  + radius) / (radius * 2)) * SIZE;
                        const py = ((-proj.y + radius) / (radius * 2)) * SIZE;

                        if (firstPx === null) {
                            ctx.moveTo(px, py);
                            firstPx = { x: px, y: py };
                        } else {
                            ctx.lineTo(px, py);
                        }
                        lastPx = { x: px, y: py };
                    });

                    if (firstPx && lastPx) {
                        const gap = Math.hypot(lastPx.x - firstPx.x, lastPx.y - firstPx.y);
                        if (gap > SIZE * 0.20) {
                            const mx = (firstPx.x + lastPx.x) / 2;
                            const my = (firstPx.y + lastPx.y) / 2;
                            let dx = mx - SIZE / 2;
                            let dy = my - SIZE / 2;
                            const dist = Math.hypot(dx, dy) || 1;
                            dx /= dist; dy /= dist;
                            const throwDist = SIZE * 2;
                            ctx.lineTo(lastPx.x + dx * throwDist, lastPx.y + dy * throwDist);
                            ctx.lineTo(firstPx.x + dx * throwDist, firstPx.y + dy * throwDist);
                        }
                        ctx.closePath();
                    }
                });
            });

            ctx.fill('evenodd');
        });
    };

    // Draw order is Z-index. Each layer paints over the previous.
    drawLayer(zData, zoningColorKey,    theme.institutional);// 1. Zoning blocks over base terrain
    drawLayer(vData, vegColorKey,       theme.veg);         // 2. Grass/nature over zoning
    drawLayer(pData, parkColorKey,      theme.park);        // 3. Parks over vegetation
    drawLayer(wData, () => 'water',     theme.water);       // 4. Water cuts over everything
    drawLayer(hData, hardscapeColorKey, null);              // 5. Hardscape (parking, plazas, aeroways) on top

    if (skiData?.features) {
        ctx.strokeStyle = '#' + new THREE.Color(theme.skiRun || 0xffffff).getHexString();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        skiData.features.forEach(feature => {
            if (!feature.properties?.['piste:type']) return;
            if (!feature.geometry) return;

            const gt = feature.geometry.type;
            if (gt === 'Point' || gt === 'MultiPoint' || gt === 'GeometryCollection') return;
            const isPoly = gt === 'Polygon' || gt === 'MultiPolygon';
            const coordsArray = (gt === 'LineString' || gt === 'Polygon') ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            ctx.lineWidth = isPoly ? 0 : Math.max(2, SIZE * 0.0015);

            ctx.beginPath();
            coordsArray.forEach(path => {
                const ring = isPoly ? path[0] : path;
                ring.forEach((pt, i) => {
                    const proj = project(pt[0], pt[1]);
                    if (!proj.valid) return;
                    const px = ((proj.x  + radius) / (radius * 2)) * SIZE;
                    const py = ((-proj.y + radius) / (radius * 2)) * SIZE;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                });
            });

            if (isPoly) ctx.fill('evenodd');
            else ctx.stroke();
        });
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY         = false;
    texture.anisotropy    = Engine.renderer.capabilities.getMaxAnisotropy();
    texture.colorSpace    = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter     = THREE.LinearFilter;
    return texture;
}

export async function loadAllLayers() {
    resetPortalHoles();
    updateLoader(0, 8, 'Topography');
    const vStr = '?v=' + Date.now();

    async function fetchLayer(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return url.endsWith('.json') ? { size: 0, data: [] } : { features: [] };
            }

            if (url.endsWith('.json') || url.endsWith('.geojson')) {
                return await response.json();
            }
            
        } catch (e) {
            console.warn(`[Data Fetch] Failed to load ${url}:`, e);
            return url.endsWith('.json') ? { size: 0, data: [] } : { features: [] };
        }
    }

    const originProj = project(Engine.meta.lon, Engine.meta.lat);
    const pfx = './' + (Engine.meta.data_path || '') + (Engine.meta.file_prefix || '');

    _topoWorldSize = 2 * (Engine.meta.radius || 1000);
    _topoInvWorldSize = 1.0 / _topoWorldSize; 
    {
        const gridJson = await fetchLayer(pfx + 'combined_topo_grid.json');
        if (gridJson?.size && Array.isArray(gridJson?.data)) {
            _topoGrid = gridJson;
            _topoSizeMinusOne = _topoGrid.size - 1;
            Engine._topoMaxElev = _topoGrid.data.reduce((m, v) => v > m ? v : m, 0);
        }
    }

    // --- BUILDINGS ---
    updateLoader(1, 8, 'Buildings');
    const aviationBeaconPts = [];
    let bData = await fetchLayer(pfx + 'combined_buildings.geojson');

    const partCenters = [];
    if (bData?.features) {
        for (const feature of bData.features) {
            if (feature.properties?.['building:part']) {
                const coord = getFirstCoord(feature.geometry);
                if (coord) {
                    const p = project(coord[0], coord[1]);
                    if (p.valid) partCenters.push({ x: p.x, z: -p.y });
                }
            }
        }
    }

    let maxH = 0;
    if (bData?.features) {
        for (const feature of bData.features) {
            if (!feature.geometry) continue;
            const gt = feature.geometry.type;
            if (gt !== 'Polygon' && gt !== 'MultiPolygon') continue;
            const props = feature.properties || {};
            const h     = parseFloat(props.height) || (parseFloat(props['building:levels']) * 4.5) || 12;
            const coord = getFirstCoord(feature.geometry);
            if (!coord) continue;
            const p    = project(coord[0], coord[1]);
            if (!p.valid) continue;
            const dist = Math.hypot(p.x - originProj.x, p.y - originProj.y);
            if (dist < 250 && h > maxH) {
                maxH                     = h;
                Engine.heroState.h       = h;
                Engine.heroState.feature = feature;
                Engine.heroState.found   = true;
            }
        }
    }

    if (Engine.heroState.found) {
        const hSlider = document.getElementById('sldHero-H');
        const hLabel  = document.getElementById('v-hero-h');
        if (hSlider) hSlider.value    = Math.round(Engine.heroState.h);
        if (hLabel)  hLabel.innerText = Math.round(Engine.heroState.h);
    }

    const matFill = new THREE.MeshBasicMaterial({
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    matFill.onBeforeCompile = applyBaseShader;

    const matGroundPlane = new THREE.MeshBasicMaterial({
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    });
    matGroundPlane.onBeforeCompile = applyBaseShader;

    matTopoFill = new THREE.MeshStandardMaterial({
        transparent: true, side: THREE.DoubleSide,
        roughness: 0.95, metalness: 0.0,
        polygonOffset: true, polygonOffsetFactor: 10, polygonOffsetUnits: 10,
    });
    registerCSMMaterial(matTopoFill);
    const csmCompileTopo = matTopoFill.onBeforeCompile;
    matTopoFill.onBeforeCompile = (shader, renderer) => {
        applyBaseShader(shader);

        shader.uniforms.topoHalfSize = { value: _topoWorldSize / 2 };

        // Portal hole uniforms — shared Float32Array with physics isInPortalHole().
        // vec4: (centerX, centerZ, radius, _pad).
        shader.uniforms.uPortalCount = Engine.uniforms.uPortalCount;
        shader.uniforms.uPortalHoles = Engine.uniforms.uPortalHoles;
        shader.vertexShader = `
            varying vec3 vTopoWorldNormal;
            varying vec3 vTopoWorldPos;
        \n${shader.vertexShader}`.replace(
            '#include <project_vertex>',
            `#include <project_vertex>
             vTopoWorldPos    = (modelMatrix * vec4(transformed, 1.0)).xyz;
             vTopoWorldNormal = normalize(mat3(modelMatrix) * normal);`
        );

        shader.fragmentShader = `
            #define VITRO_MAX_PORTAL_HOLES 128
            varying vec3 vTopoWorldNormal;
            varying vec3 vTopoWorldPos;
            uniform float topoHalfSize;
            uniform int  uPortalCount;
            uniform vec4 uPortalHoles[VITRO_MAX_PORTAL_HOLES];
        \n${shader.fragmentShader}`.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
                vec2 _groundUV = vec2(
                    (vTopoWorldPos.x + topoHalfSize) / (topoHalfSize * 2.0),
                    (vTopoWorldPos.z + topoHalfSize) / (topoHalfSize * 2.0)
                );
                vec4 _texSample = texture2D(map, _groundUV);
                diffuseColor.rgb = _texSample.rgb;
                diffuseColor.a  *= _texSample.a;
            #endif

            // ── Portal hole carving ──────────────────────────────────────
            vec2 posXZ = vTopoWorldPos.xz;
            for (int _ph = 0; _ph < VITRO_MAX_PORTAL_HOLES; _ph++) {
                if (_ph >= uPortalCount) break;
                vec4 _phD = uPortalHoles[_ph];


                vec2 _phV = posXZ - _phD.xy;
                // FAST REJECT
                if (abs(_phV.x) > _phD.z || abs(_phV.y) > _phD.z) continue;
                
                if (dot(_phV, _phV) < _phD.z * _phD.z) discard;
            }`
        );

        csmCompileTopo(shader, renderer);
    };

    const _initRes = new THREE.Vector2();
    Engine.renderer.getSize(_initRes);

    const matRoadGround = new THREE.MeshStandardMaterial({
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -15, polygonOffsetUnits: -15, // THE FIX: Aggressive GPU depth sorting
        depthTest: true, depthWrite: true,
    });
    registerCSMMaterial(matRoadGround);
    const csmRoadG = matRoadGround.onBeforeCompile;
    matRoadGround.onBeforeCompile = (s, r) => {
        applyBaseShader(s);
        applyLaneLineShader(s);
        csmRoadG(s, r);
    };

    const matSidewalkGround = new THREE.MeshStandardMaterial({
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
        depthTest: true, depthWrite: true,
    });
    registerCSMMaterial(matSidewalkGround);
    const csmSidewalkG = matSidewalkGround.onBeforeCompile;
    matSidewalkGround.onBeforeCompile = (s, r) => {
        applyBaseShader(s);
        csmSidewalkG(s, r);
    };

    const matRoadBridge = new THREE.MeshStandardMaterial({
        color: Engine.currentTheme.road,
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
    });
    registerCSMMaterial(matRoadBridge);
    const csmRoadB = matRoadBridge.onBeforeCompile;
    matRoadBridge.onBeforeCompile = (s, r) => { applyBaseShader(s); applyLaneLineShader(s); csmRoadB(s, r); };

    const matSidewalkBridge = new THREE.MeshStandardMaterial({
        color: Engine.currentTheme.sidewalk,
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
    });
    registerCSMMaterial(matSidewalkBridge);
    const csmSidewalkB = matSidewalkBridge.onBeforeCompile;
    matSidewalkBridge.onBeforeCompile = (s, r) => { applyBaseShader(s); csmSidewalkB(s, r); };

    // ── TUNNEL MATERIALS ──────────────────────────────────────────────────
    // Interior tube: dark concrete, DoubleSide so the merged chunk can be
    // entered without backface-culling artifacts. No CSM — underground should
    // not receive sun. Standard material for the ambient light contribution.
    const matTunnelInterior = new THREE.MeshStandardMaterial({
        color: 0x2a2a2c,
        roughness: 0.95,
        metalness: 0.0,
        side: THREE.DoubleSide,
    });
    // Plinth clipping only — no CSM registration (tunnels ignore sun entirely)
    const compileTunnelI = matTunnelInterior.onBeforeCompile;
    matTunnelInterior.onBeforeCompile = (s, r) => { applyBaseShader(s); if (compileTunnelI) compileTunnelI(s, r); };

    // Portal frame: slightly lighter concrete, catches sun (CSM-registered)
    const matTunnelPortal = new THREE.MeshStandardMaterial({
        color: 0x4a4a4e,
        roughness: 0.88,
        metalness: 0.0,
        side: THREE.DoubleSide,
    });
    registerCSMMaterial(matTunnelPortal);
    const compileTunnelP = matTunnelPortal.onBeforeCompile;
    matTunnelPortal.onBeforeCompile = (s, r) => { applyBaseShader(s); if (compileTunnelP) compileTunnelP(s, r); };

    // Emissive ceiling strip: MeshBasicMaterial = ZERO lighting cost. This is
    // what makes underground scenes look alive without dynamic point lights.
    // Thick fog + dense emissive streaks = volumetric light feeling.
    const matTunnelStrip = new THREE.MeshBasicMaterial({
        color: 0xfff4d8,
        toneMapped: false,
        fog: true,
    });
    Engine.matTunnelStrip = matTunnelStrip;
    Engine.matTunnelInterior = matTunnelInterior;
    Engine.matTunnelPortal = matTunnelPortal;

    const matRailGround = new THREE.MeshStandardMaterial({
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -20, polygonOffsetUnits: -20, // THE FIX: Keep rails above roads
        depthTest: true, depthWrite: true,
    });
    registerCSMMaterial(matRailGround);
    const csmRailG = matRailGround.onBeforeCompile;
    matRailGround.onBeforeCompile = (s, r) => { applyBaseShader(s); csmRailG(s, r); };

    const matRailBridge = new THREE.MeshStandardMaterial({
        color: Engine.currentTheme.rail,
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
    });
    registerCSMMaterial(matRailBridge);
    const csmRailB = matRailBridge.onBeforeCompile;
    matRailBridge.onBeforeCompile = (s, r) => { applyBaseShader(s); csmRailB(s, r); };

    const matSkiRun = new THREE.MeshStandardMaterial({
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        depthTest: true, depthWrite: true,
    });
    registerCSMMaterial(matSkiRun);
    const csmSkiRun = matSkiRun.onBeforeCompile;
    matSkiRun.onBeforeCompile = (s, r) => { applyBaseShader(s); csmSkiRun(s, r); };

    const matSkiLift = new THREE.MeshStandardMaterial({
        roughness: 1.0, metalness: 0.0,
        transparent: true, side: THREE.DoubleSide,
    });
    registerCSMMaterial(matSkiLift);
    const csmSkiLift = matSkiLift.onBeforeCompile;
    matSkiLift.onBeforeCompile = (s, r) => { applyBaseShader(s); csmSkiLift(s, r); };

    const matContextFill = new THREE.MeshStandardMaterial({
        transparent: true, side: THREE.DoubleSide,
        roughness: 0.90, metalness: 0.0,
    });
    registerCSMMaterial(matContextFill);
    const csmCompileCtx = matContextFill.onBeforeCompile;
    matContextFill.onBeforeCompile = (shader, renderer) => {
        applyContextShader(shader);
        csmCompileCtx(shader, renderer);
    };

    const matBuildingFill = new THREE.MeshStandardMaterial({
        transparent: false, // Ensure Early-Z culling is active for performance
        side: THREE.DoubleSide,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.0,
        polygonOffset: true, polygonOffsetFactor: 20, polygonOffsetUnits: 20,
    });
    registerCSMMaterial(matBuildingFill);
    const csmCompileBldg = matBuildingFill.onBeforeCompile;
    matBuildingFill.onBeforeCompile = (shader, renderer) => {
        applyContextShader(shader);
        // Portal hack completely removed.
        csmCompileBldg(shader, renderer);
    };

    const matContextLine = new LineMaterial({
        color: 0x000000, linewidth: 1.5, transparent: true,
        alphaToCoverage: true, 
    });
    matContextLine.resolution.copy(_initRes);
    matContextLine.onBeforeCompile = applyContextShaderLine2;

    const matGroundLine = new LineMaterial({
        color: 0x000000, linewidth: 1.0, transparent: true, opacity: 0.4,
        alphaToCoverage: true, 
    });
    matGroundLine.resolution.copy(_initRes);
    matGroundLine.onBeforeCompile = applyContextShaderLine2;

    const mergeBgFills  = [], mergeBgWires  = [];
    const mergeRoofFill = [], mergeRoofWire = [];
    const mergeDetails  = [];
    const _mats = { ctxFill: matContextFill, bldgFill: matBuildingFill, ctxLine: matContextLine };
    const FLUSH_EVERY = 500;
    let _featureCount = 0;

    if (bData?.features) {
        for (const feature of bData.features) {
            if (!feature.geometry) continue;
            const gt = feature.geometry.type;
            if (gt !== 'Polygon' && gt !== 'MultiPolygon') continue;

            const coord = getFirstCoord(feature.geometry);
            if (!coord) continue;
            const p = project(coord[0], coord[1]);
            if (!p.valid) continue;
            let heroDist = Math.hypot(p.x - originProj.x, p.y - originProj.y);
            if (isNaN(heroDist)) heroDist = Infinity;

            const isGhostTarget = (feature === Engine.heroState.feature);
            const featureId = Math.random();
            const props = feature.properties || {};
            const isBuildingPart = !!(props['building:part']);

            const mm  = (props.man_made || '').toLowerCase();
            const his = (props.historic  || '').toLowerCase();
            const tou = (props.tourism   || '').toLowerCase();
            const am  = (props.amenity   || '').toLowerCase();
            const bld = (props.building  || '').toLowerCase();
            const pw  = (props.power     || '').toLowerCase();
            
            let defaultH = 12;
            if (isBuildingPart) defaultH = 15;
            else if (mm === 'campanile')                               defaultH = 50;
            else if (mm === 'tower' || mm === 'lighthouse')            defaultH = 35;
            else if (mm === 'chimney' || mm === 'cooling_tower')       defaultH = 40;
            else if (mm === 'water_tower')                             defaultH = 20;
            else if (mm === 'obelisk')                                 defaultH = 30;
            else if (mm === 'mast' || mm === 'antenna')                defaultH = 25;
            else if (mm === 'flagpole')                                defaultH = 15;
            else if (his === 'monument' || his === 'memorial')         defaultH = 10;
            else if (his === 'fort' || his === 'castle')               defaultH = 12;
            else if (am  === 'fountain')                               defaultH =  3;
            else if (am  === 'place_of_worship')                       defaultH = 18;
            else if (bld === 'church' || bld === 'cathedral' ||
                     bld === 'mosque' || bld === 'temple')             defaultH = 20;
            else if (pw  === 'tower')                                  defaultH = 30;

            const h = parseFloat(props.height) || (parseFloat(props['building:levels']) * 4.5) || defaultH;
            
            const isBuilding       = !!(props.building || props['building:part']) && !mm && !his && !tou && am !== 'fountain';
            const isUndergroundBldg = props.location === 'underground' || props.tunnel === 'yes' || props.underground === 'yes';
            // building_passage features represent empty space (archways/passages through buildings).
            // They have no building tag — skip them so they don't render as solid walls.
            if (props.tunnel === 'building_passage') continue;
            // Surface parking is baked into the canvas terrain texture — skip it here
            if (props.amenity === 'parking' && props.parking !== 'multi-storey') continue;

            // THE FIX: Smart Elevation Fallback
            let explicitMinH = parseFloat(props.min_height);
            if (isNaN(explicitMinH)) explicitMinH = parseFloat(props.min_floor) * 3.5;
            
            // If OSM lacks min_height, but it's explicitly a bridge or on a layer > 0, float it!
            if (isNaN(explicitMinH) || explicitMinH <= 0) {
                const bLayer = parseFloat(props.layer);
                if (bLayer > 0) {
                    explicitMinH = bLayer * 4.5; // 4.5m clearance per layer
                } else if (props.bridge === 'yes') {
                    explicitMinH = 4.5;
                }
            }
            
            const minH = Math.max(0, explicitMinH || 0);

            let depth = Math.max(1, h - minH);
            if (!isBuildingPart && depth > 3) {
                depth -= 0.5;
            }

            const roofShape = (props['roof:shape'] || '').toLowerCase();

            let roofEdgeAngle = 30;
            if (roofShape === 'dome' || roofShape === 'onion') roofEdgeAngle = 1;
            else if (roofShape === 'cone') roofEdgeAngle = 15;

            const rings     = getRings(feature.geometry);

            let containsParts = false;
            if (!isBuildingPart && rings.length > 0 && rings[0][0]) {
                const worldRing = [];
                for (const pt of rings[0][0]) {
                    const v = project(pt[0], pt[1]);
                    if (v.valid) worldRing.push({ x: v.x, z: -v.y });
                }

                if (worldRing.length > 2) {
                    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                    for (const p of worldRing) {
                        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
                    }

                    for (const pc of partCenters) {
                        if (pc.x >= minX && pc.x <= maxX && pc.z >= minZ && pc.z <= maxZ) {
                            if (pointInRing(pc.x, pc.z, worldRing)) {
                                containsParts = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (containsParts) {
                continue; 
            }

            const roofH     = containsParts ? 0 : Math.min(Math.max(0, parseFloat(props['roof:height']) || 0), depth * 0.5);

            let baseColorHex = getOSMColor(props['building:color'] || props.color, 0xffffff);
            if (!isBuildingPart) {
                const c = new THREE.Color(baseColorHex);
                c.multiplyScalar(0.95);
                baseColorHex = c.getHex();
            }
            const bldgColor = baseColorHex;
            const roofColor = getOSMColor(props['roof:color'], bldgColor);
            const levels    = parseInt(props['building:levels']) || 0;

            for (const ring of rings) {
                const shape = buildShape([ring[0]]);
                if (!shape || shape.curves.length === 0) continue;

                let cx = 0, cy = 0;
                const pts = [];
                for (const pt of ring[0]) {
                    const v = project(pt[0], pt[1]);
                    if (v.valid) { cx += v.x; cy += v.y; pts.push(v); }
                }
                if (pts.length === 0) continue;
                cx /= pts.length; cy /= pts.length;

                let baseElev = getElevationAt(cx, -cy);
                const stride = Math.max(1, Math.floor(pts.length / 8));
                for (let pi = 0; pi < pts.length; pi += stride) {
                    baseElev = Math.min(baseElev, getElevationAt(pts[pi].x, -pts[pi].y));
                }

                if (isBuildingPart) {
                    baseElev = Math.round(baseElev * 2) / 2;
                }

                let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
                const polyRing = [];

                for (const p of pts) {
                    const z3d = -p.y;
                    polyRing.push({ x: p.x, z: z3d });
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (z3d < minZ) minZ = z3d;
                    if (z3d > maxZ) maxZ = z3d;
                }

                const keys = getGridKeys(minX, maxX, minZ, maxZ);

                // Underground buildings (location=underground, subway stations, etc.) are
                // registered as cavernous spaces rather than surface structures. They sit
                // below the terrain, so the player can enter and stand inside them.
                // The cavern floor is baseElev - depthUG, ceiling is baseElev - depthUG + h.
                // We don't extrude them upward — they're hollow underground rooms.
                if (isUndergroundBldg) {
                    const ugLayer = Math.abs(parseFloat(props.layer) || 1);
                    const depthUG = ugLayer * 6.0 + 8.0; // matches rail tunnel depth formula
                    const yFloor   = baseElev - depthUG;
                    const yCeiling = yFloor + h;
                    injectCavernToGrid(polyRing, yFloor, yCeiling);
                    // Skip surface extrusion — underground buildings have no above-ground footprint
                    continue;
                }

                // Physics top uses the full OSM height (baseElev + h), not the
                // visually-reduced depth. The depth -= 0.5 trim is purely aesthetic
                // (wall mesh stops slightly below the roof mesh), but the landing
                // surface must match the visual roof plane so players don't land
                // 0.5 m below the visible roof (the source of invisible roof barriers).
                const physicalTop = baseElev + h;
                const bldgData = { type: 'building', ring: polyRing, yBase: baseElev + minH, yTop: physicalTop };

                for (const k of keys) {
                    if (!SpatialGrid.has(k)) SpatialGrid.set(k, []);
                    SpatialGrid.get(k).push(bldgData);
                }

                // FIX: Raise threshold to 100m to reduce beacon spam
                const isObstruction = h > 100 || 
                                      mm === 'mast' || 
                                      mm === 'tower' || 
                                      mm === 'wind_turbine' || 
                                      mm === 'lighthouse' || 
                                      props.aeroway === 'control_tower';

                if (isObstruction) {
                    aviationBeaconPts.push({ x: p.x, y: baseElev + h, z: -p.y, id: featureId });
                }

                let _a2 = 0;
                for (let _i = 0, _j = pts.length - 1; _i < pts.length; _j = _i++) {
                    _a2 += (pts[_j].x - pts[_i].x) * (pts[_j].y + pts[_i].y);
                }
                if (Math.abs(_a2) * 0.5 > 500000) continue;

                const bldgEdgeAngle = 55;

                let geo;
                let rawGeo;
                if (depth === 0) {
                    rawGeo = new THREE.ShapeGeometry(shape);
                } else {
                    rawGeo = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false });
                }
                rawGeo.rotateX(-Math.PI / 2);
                rawGeo.translate(0, baseElev + minH, 0);

                geo = BufferGeometryUtils.mergeVertices(rawGeo, 1e-4);
                rawGeo.dispose(); 

                if (!geo.attributes.position || isNaN(geo.attributes.position.array[0])) { 
                    geo.dispose(); 
                    continue; 
                }

                geo.computeBoundingSphere(); 

                const roofGeo = buildRoofGeometry(pts, baseElev + h, roofShape, roofH);

                applyVertexColors(geo, bldgColor);
                if (roofGeo) applyVertexColors(roofGeo, roofColor);

                if (heroDist > Engine.FG_THRESHOLD && !isGhostTarget) {
                    mergeBgFills.push(geo);
                    mergeBgWires.push(new THREE.EdgesGeometry(geo, bldgEdgeAngle));

                    if (roofGeo) {
                        mergeRoofFill.push(roofGeo);
                        mergeRoofWire.push(new THREE.EdgesGeometry(roofGeo, roofEdgeAngle));
                    } else if (isBuilding && h > 20 && pts.length >= 4) {
                        const acGeo = new THREE.BoxGeometry(2.5, 1.5, 2.5);
                        acGeo.translate(cx, baseElev + h + 0.75, -cy);
                        applyVertexColors(acGeo, roofColor);
                        mergeRoofFill.push(acGeo);
                        mergeRoofWire.push(new THREE.EdgesGeometry(acGeo, 30));
                    }

                    if (isBuilding && h > 15) {
                        const winPts = buildWindowLines(pts, baseElev + h, levels, baseElev + minH);
                        if (winPts.length > 1) mergeDetails.push(new THREE.BufferGeometry().setFromPoints(winPts));
                    }
                } else {
                    const ud = { isGhost: isGhostTarget, px: cx, pz: -cy, featureId, baseY: baseElev };

                    const mesh = new THREE.Mesh(geo, matBuildingFill);
                    mesh.userData = { ...ud };
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
                    Engine.groups.bFill.add(mesh);

                    const wire = new LineSegments2(edgesToLineGeo(new THREE.EdgesGeometry(geo, bldgEdgeAngle)), matContextLine);
                    wire.userData = { ...ud };
                    wire.matrixAutoUpdate = false; wire.updateMatrix();
                    Engine.groups.bWire.add(wire);

                    if (roofGeo) {
                        const roofMesh = new THREE.Mesh(roofGeo, matBuildingFill);
                        roofMesh.userData = { ...ud };
                        roofMesh.castShadow = true;
                        roofMesh.receiveShadow = true;
                        roofMesh.matrixAutoUpdate = false; roofMesh.updateMatrix();
                        Engine.groups.roofs.add(roofMesh);

                        const roofWire = new LineSegments2(edgesToLineGeo(new THREE.EdgesGeometry(roofGeo, roofEdgeAngle)), matContextLine);
                        roofWire.userData = { ...ud };
                        roofWire.matrixAutoUpdate = false; roofWire.updateMatrix();
                        Engine.groups.roofs.add(roofWire);
                    } else if (isBuilding && h > 20 && pts.length >= 4) {
                        const acGeo  = new THREE.BoxGeometry(2.5, 1.5, 2.5);
                        applyVertexColors(acGeo, roofColor);
                        const acMesh = new THREE.Mesh(acGeo, matBuildingFill);
                        acMesh.position.set(cx, baseElev + h + 0.75, -cy);
                        acMesh.userData = { ...ud };
                        acMesh.castShadow = false; 
                        acMesh.receiveShadow = true;
                        acMesh.matrixAutoUpdate = false; acMesh.updateMatrix();
                        Engine.groups.roofs.add(acMesh);

                        const acWire = new LineSegments2(edgesToLineGeo(new THREE.EdgesGeometry(acGeo, 30)), matContextLine);
                        acWire.position.set(cx, baseElev + h + 0.75, -cy);
                        acWire.userData = { ...ud };
                        acWire.matrixAutoUpdate = false; acWire.updateMatrix();
                        Engine.groups.roofs.add(acWire);
                    }

                    if (isBuilding && h > 15) {
                        const winPts = buildWindowLines(pts, baseElev + h, levels, baseElev + minH);
                        if (winPts.length > 1) {
                            const winLines = new LineSegments2(
                                edgesToLineGeo(new THREE.BufferGeometry().setFromPoints(winPts)),
                                matContextLine
                            );
                            winLines.userData = { ...ud };
                            winLines.matrixAutoUpdate = false; winLines.updateMatrix();
                            Engine.groups.detail.add(winLines);
                        }
                    }
                }
            }
            if (++_featureCount % FLUSH_EVERY === 0) {
                await flushMerge(mergeBgFills, mergeBgWires, mergeRoofFill, mergeRoofWire, mergeDetails, _mats);
            }
        }
        await flushMerge(mergeBgFills, mergeBgWires, mergeRoofFill, mergeRoofWire, mergeDetails, _mats);
    }
    bData = null;

    if (aviationBeaconPts.length > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');    
        grad.addColorStop(0.2, 'rgba(255, 50, 50, 1)');    
        grad.addColorStop(1, 'rgba(255, 0, 0, 0)');        
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        const flareTex = new THREE.CanvasTexture(canvas);

        Engine.matAviationLight = new THREE.PointsMaterial({
            size: 5, 
            sizeAttenuation: false,
            map: flareTex,
            transparent: true,
            opacity: 0.0,
            blending: THREE.AdditiveBlending, 
            depthWrite: false,
            depthTest: true 
        });

        const positions = new Float32Array(aviationBeaconPts.length * 3);
        aviationBeaconPts.forEach((pt, i) => {
            positions[i * 3]     = pt.x;
            positions[i * 3 + 1] = pt.y + 2.0; 
            positions[i * 3 + 2] = pt.z;
        });

        const beaconGeo = new THREE.BufferGeometry();
        beaconGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const beaconPoints = new THREE.Points(beaconGeo, Engine.matAviationLight);
        beaconPoints.frustumCulled = false;
        Engine.groups.lights.add(beaconPoints);

        console.log(`  Rendered ${aviationBeaconPts.length} aviation optical flares.`);
    }

    async function safeMassMerge(geoArray, material, group, colorKey, castShadow) {
        if (geoArray.length === 0) return;
        spatialSort(geoArray);

        // Normalize: if the array mixes indexed and non-indexed geometries, convert
        // everything to non-indexed so mergeBufferGeometries never sees a mismatch.
        const hasIndex    = geoArray.some(g => g.index !== null);
        const hasNoIndex  = geoArray.some(g => g.index === null);
        if (hasIndex && hasNoIndex) {
            for (let k = 0; k < geoArray.length; k++) {
                if (geoArray[k].index !== null) {
                    const expanded = geoArray[k].toNonIndexed();
                    geoArray[k].dispose();
                    geoArray[k] = expanded;
                }
            }
        }

        const CHUNK_SIZE = 250;
        for (let i = 0; i < geoArray.length; i += CHUNK_SIZE) {
            const chunk = geoArray.slice(i, i + CHUNK_SIZE);
            const merged = BufferGeometryUtils.mergeBufferGeometries(chunk);
            chunk.forEach(g => g.dispose());
            if (merged) {
                merged.computeBoundingBox();
                merged.computeBoundingSphere();
                const mesh = new THREE.Mesh(merged, material);
                mesh.castShadow = castShadow;
                mesh.receiveShadow = true;
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                mesh.userData.colorKey = colorKey;
                group.add(mesh);
            }
            await yieldThread();
        }
    }

    // --- SAFE MASS-MERGE UTILITY FOR WIRES ---
    async function safeMassMergeWires(geoArray, material, group, colorKey) {
        if (geoArray.length === 0) return;
        spatialSort(geoArray);

        const CHUNK_SIZE = 250;
        for (let i = 0; i < geoArray.length; i += CHUNK_SIZE) {
            const chunk = geoArray.slice(i, i + CHUNK_SIZE);
            const merged = BufferGeometryUtils.mergeBufferGeometries(chunk);
            chunk.forEach(g => g.dispose());
            if (merged) {
                merged.computeBoundingBox();
                merged.computeBoundingSphere();

                const lineGeo = new LineSegmentsGeometry();
                lineGeo.setPositions(merged.attributes.position.array);
                merged.dispose();

                const mesh = new LineSegments2(lineGeo, material);
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                mesh.userData.colorKey = colorKey;
                group.add(mesh);
            }
            await yieldThread();
        }
    }

    // --- ROADS ---
    updateLoader(2, 8, 'Roads & Bridges');
    let sData = await fetchLayer(pfx + 'combined_skeleton.geojson');

    const roadNodes = new Map();
    if (sData?.features) {
        for (const feature of sData.features) {
            if (!feature.geometry || !feature.geometry.type.includes('LineString')) continue;
            const props = feature.properties || {};
            const isBridge = props.bridge === 'yes' || props.bridge === 'aqueduct' || props.bridge === 'viaduct';
            // tunnel=yes is a true underground tunnel; building_passage stays on ground
            const isTunnel = props.tunnel === 'yes';
            const coordsArray = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const key = `${pt[0].toFixed(5)}_${pt[1].toFixed(5)}`;
                    if (!roadNodes.has(key)) roadNodes.set(key, { bridge: false, ground: false, tunnel: false });
                    if (isBridge) roadNodes.get(key).bridge = true;
                    else if (isTunnel) roadNodes.get(key).tunnel = true;
                    else roadNodes.get(key).ground = true;
                }
            }
        }
    }

    if (sData?.features) {
        const roadGroundGeos = [];
        const sidewalkGroundGeos = [];
        const roadBridgeGeos = [];
        const sidewalkBridgeGeos = [];
        const roadTunnelGeos = [];       // interior tube
        const roadTunnelPortalGeos = []; // portal frames
        const roadTunnelStripGeos = [];  // emissive ceiling strips

        // --- Bridge Polygon geometry ---
        // OSM bridge=yes Polygon/MultiPolygon features define the physical deck footprint.
        // Build a thin extruded slab per polygon, lifted to the same hOffset used by the
        // LineString bridges, so the two approaches align vertically.
        // Also collect projected rings for LineString dedup (if a LineString start falls
        // inside a bridgePoly ring, skip the volumetric LineString entirely).
        const bridgePolyRings = [];

        for (const feature of sData.features) {
            const gt = feature.geometry?.type;
            if (gt !== 'Polygon' && gt !== 'MultiPolygon') continue;
            const props = feature.properties || {};
            // Explicit bridge tags (man_made=bridge, bridge=yes/aqueduct/viaduct) catch
            // explicitly mapped deck polygons. The layer>=1 && !highway fallback catches
            // bridge-platform polygons that were fetched via the man_made filter but whose
            // man_made column wasn't exported (e.g. John T. Meyers Pedestrian Bridge).
            // The !highway guard prevents pedestrian plazas (highway=pedestrian, layer=2)
            // from being mistaken for elevated bridge decks.
            const isBridgePoly = props.man_made === 'bridge' ||
                props.bridge === 'yes' || props.bridge === 'aqueduct' || props.bridge === 'viaduct' ||
                (parseFloat(props.layer) >= 1 && !props.highway);
            if (!isBridgePoly) continue;

            const layer = parseFloat(props.layer) || 1;
            const hType = (props.highway || '').toLowerCase();
            const priorityOffset = (hType === 'motorway' || hType === 'trunk') ? 0.6
                : (hType === 'primary' || hType === 'secondary') ? 0.4 : 0.2;
            const hOffset = (layer > 0 ? (layer * 5.0) + priorityOffset : 5.5 + priorityOffset);
            const DECK_THICK = 0.5;

            for (const polyArray of getRings(feature.geometry)) {
                const shape = buildShape(polyArray);
                if (!shape) continue;

                // Compute a single flat deck elevation from boundary vertices.
                // Per-vertex sampling fails for water crossings (getElevationAt
                // returns water-surface ~0m there). Taking the max of sampled
                // perimeter elevations anchors the deck to the land approaches,
                // matching how LineString bridges use startY/endY.
                const outerRing = polyArray[0];
                let deckBaseY = -Infinity;
                const step = Math.max(1, Math.floor(outerRing.length / 16));
                for (let i = 0; i < outerRing.length; i += step) {
                    const pt = outerRing[i];
                    if (!pt || pt.length < 2) continue;
                    const p = project(pt[0], pt[1]);
                    if (!p.valid) continue;
                    const ey = getElevationAt(p.x, -p.y);
                    if (ey > deckBaseY) deckBaseY = ey;
                }
                if (deckBaseY === -Infinity) deckBaseY = 0;
                const deckTopY = deckBaseY + hOffset;

                const geo = new THREE.ExtrudeGeometry(shape, {
                    depth: DECK_THICK,
                    bevelEnabled: false,
                    curveSegments: 1,
                });
                geo.rotateX(-Math.PI / 2);

                // Set all vertices to the flat deck height.
                // vy=0 → top surface, vy=DECK_THICK → underside.
                const pos = geo.attributes.position;
                for (let vi = 0; vi < pos.count; vi++) {
                    const vy = pos.getY(vi);
                    pos.setY(vi, deckTopY - vy); // vy=0 → deckTopY; vy=DECK_THICK → deckTopY-0.5
                }
                pos.needsUpdate = true;
                geo.deleteAttribute('uv');
                // Zero-fill roadUV/roadED so this polygon-bridge geo matches the attribute
                // layout of ribbon/volumetric deck geos in the same merge batch.
                const polyCount = geo.attributes.position.count;
                geo.setAttribute('roadUV', new THREE.Float32BufferAttribute(new Float32Array(polyCount * 2), 2));
                geo.setAttribute('roadED', new THREE.Float32BufferAttribute(new Float32Array(polyCount),     1));
                geo.computeVertexNormals();
                roadBridgeGeos.push(geo);

                // Inject the entire polygon as a solid bridgePoly into the SpatialGrid.
                // Using pointInRing (same as buildings) fills the whole deck surface —
                // no hollow-donut effect from perimeter-segment capsules.
                let bpMinX = Infinity, bpMaxX = -Infinity, bpMinZ = Infinity, bpMaxZ = -Infinity;
                const projRing = [];
                for (const pt of outerRing) {
                    if (!pt || pt.length < 2) continue;
                    const p = project(pt[0], pt[1]);
                    if (!p.valid) continue;
                    projRing.push({ x: p.x, z: -p.y });
                    if (p.x < bpMinX) bpMinX = p.x; if (p.x > bpMaxX) bpMaxX = p.x;
                    if (-p.y < bpMinZ) bpMinZ = -p.y; if (-p.y > bpMaxZ) bpMaxZ = -p.y;
                }
                if (projRing.length >= 3) {
                    const polyData = { type: 'bridgePoly', ring: projRing, yTop: deckTopY };
                    // THE FIX: Expand the injection bounding box by 5m so the fuzzy snap can reach it
                    const TOL = 5.0;
                    for (const k of getGridKeys(bpMinX - TOL, bpMaxX + TOL, bpMinZ - TOL, bpMaxZ + TOL)) {
                        if (!SpatialGrid.has(k)) SpatialGrid.set(k, []);
                        SpatialGrid.get(k).push(polyData);
                    }
                    bridgePolyRings.push(projRing);
                }
            }
        }

        // ============================================================================
        // TWO-PASS ROUTING LOOP: Fix execution order race condition
        // ============================================================================
        // LOOP 1: Process only bridges and deep tunnels (inject into SpatialGrid first)
        // LOOP 2: Process ground roads, stairs, and surface tunnels (query SpatialGrid after bridges are injected)
        // ============================================================================
        
        // LOOP 1: Bridges and Deep Tunnels (inject into SpatialGrid)
        for (const feature of sData.features) {
            if (!feature.geometry || !feature.geometry.type.includes('LineString')) continue;
            const props = feature.properties || {};
            
            const isTunnel = props.tunnel === 'yes';
            const isBuildingPassage = props.tunnel === 'building_passage';
            const isCovered = props.covered === 'yes';

            // THE FIX: Safe layer parsing. Do not assume missing layers mean deep tunnels. Default to 0.
            const parsedLayer = parseFloat(props.layer);
            let layer = isNaN(parsedLayer) ? 0 : parsedLayer;

            const isBridge = props.bridge === 'yes' || props.bridge === 'aqueduct' || props.bridge === 'viaduct';

            let forceIsBridge = isBridge;
            // A tunnel is ONLY a tunnel if OSM explicitly buries it below layer 0.
            // Building passages, covered walkways, and lazy layer 0 tunnels are demoted to standard roads.
            let forceIsTunnel = isTunnel && layer < 0;
            let halfW = getRoadHalfWidth(props) + (isBridge ? 0.5 : 0);

            const hType = (props.highway || '').toLowerCase();

            // SURGICAL STRIKE 1: Instantly amputate all stairways/sloped ribbons
            if (hType === 'steps' || hType === 'corridor') {
                continue;
            }

            // Bridges cannot also be tunnels
            if (forceIsBridge) forceIsTunnel = false;

            // LOOP 1 ONLY PROCESSES: bridges and deep tunnels (NOT surface tunnels)
            if (!forceIsBridge && !forceIsTunnel) {
                continue; // Skip ground roads, stairs, and surface tunnels in Loop 1
            }
            
            const priorityOffset = (hType === 'motorway' || hType === 'trunk') ? 0.6 : (hType === 'primary' || hType === 'secondary') ? 0.4 : 0.2;
            const hasMarkings = hType !== 'footway' && hType !== 'path' && hType !== 'pedestrian' &&
                                 hType !== 'cycleway' && hType !== 'steps' && hType !== 'track';

            const coordsArray = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                const projPts = [];
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const proj = project(pt[0], pt[1]);
                    if (proj.valid) projPts.push(proj);
                }
                if (projPts.length < 2) continue;

                if (forceIsBridge) {
                    const pStart = projPts[0];
                    const pEnd = projPts[projPts.length - 1];

                    // If this LineString's start falls inside a bridge polygon, the polygon
                    // is the authoritative structure for this span — skip the volumetric build.
                    if (bridgePolyRings.some(ring => pointInRing(pStart.x, -pStart.y, ring))) continue;

                    const startY = getElevationAt(pStart.x, -pStart.y);
                    const endY = getElevationAt(pEnd.x, -pEnd.y);

                    const hOffset = (layer > 0 ? (layer * 5.0) + priorityOffset : 5.5 + priorityOffset);

                    const startKey = `${path[0][0].toFixed(5)}_${path[0][1].toFixed(5)}`;
                    const endKey = `${path[path.length-1][0].toFixed(5)}_${path[path.length-1][1].toFixed(5)}`;

                    const taperStart = roadNodes.get(startKey)?.ground === true;
                    const taperEnd = roadNodes.get(endKey)?.ground === true;

                    const bridge = buildVolumetricBridge(projPts, startY, endY, hOffset, halfW, taperStart, taperEnd, 0.4 + priorityOffset, hasMarkings);
                    if (bridge) {
                        const isSidewalkBridge = hType === 'footway' || hType === 'path' || hType === 'pedestrian' || hType === 'cycleway' || hType === 'steps';
                        const bridgeTarget = isSidewalkBridge ? sidewalkBridgeGeos : roadBridgeGeos;
                        if (bridge.deckGeo) bridgeTarget.push(bridge.deckGeo);
                        if (bridge.pierGeo) bridgeTarget.push(bridge.pierGeo);
                    }
                } else if (forceIsTunnel) {
                    // Deep tunnel (underground) - inject into SpatialGrid
                    // Real-world clearance standards
                    let clearance = 4.5;
                    switch (hType) {
                        case 'motorway': case 'trunk': clearance = 5.5; break;
                        case 'primary': case 'secondary': clearance = 5.0; break;
                        case 'pedestrian': case 'footway': case 'cycleway': case 'path': clearance = 2.8; break; // Shallow underpass
                    }
                    
                    // THE FIX: Depth is strictly tied to clearance.
                    // No more plunging 16m into the earth. Floor drops exactly enough to hide the roof.
                    const depthOffset = clearance + 1.2;

                    const startKey = `${path[0][0].toFixed(5)}_${path[0][1].toFixed(5)}`;
                    const endKey = `${path[path.length-1][0].toFixed(5)}_${path[path.length-1][1].toFixed(5)}`;

                    const startNode = roadNodes.get(startKey);
                    const endNode   = roadNodes.get(endKey);
                    const taperStart = startNode?.ground === true || startNode?.bridge === true;
                    const taperEnd   = endNode?.ground   === true || endNode?.bridge   === true;
                    const nsTunnel = !taperStart && startNode?.tunnel === true;
                    const neTunnel = !taperEnd   && endNode?.tunnel   === true;

                    const tunnel = buildVolumetricTunnel(projPts, halfW, clearance, depthOffset, taperStart, taperEnd, nsTunnel, neTunnel);
                    if (tunnel) {
                        if (tunnel.tubeGeo)   roadTunnelGeos.push(tunnel.tubeGeo);
                        if (tunnel.portalGeo) roadTunnelPortalGeos.push(tunnel.portalGeo);
                        if (tunnel.stripGeo)  roadTunnelStripGeos.push(tunnel.stripGeo);
                    }
                }
                // Note: ground roads, stairs, and surface tunnels are skipped in Loop 1
            }
        }
        
        // LOOP 2: Ground Roads, Stairs, and Surface Tunnels (query SpatialGrid)
        for (const feature of sData.features) {
            if (!feature.geometry || !feature.geometry.type.includes('LineString')) continue;
            const props = feature.properties || {};
            
            const isTunnel = props.tunnel === 'yes';
            const isBuildingPassage = props.tunnel === 'building_passage';
            const isCovered = props.covered === 'yes';

            // THE FIX: Safe layer parsing. Do not assume missing layers mean deep tunnels. Default to 0.
            const parsedLayer = parseFloat(props.layer);
            let layer = isNaN(parsedLayer) ? 0 : parsedLayer;

            const isBridge = props.bridge === 'yes' || props.bridge === 'aqueduct' || props.bridge === 'viaduct';

            let forceIsBridge = isBridge;
            // A tunnel is ONLY a tunnel if OSM explicitly buries it below layer 0.
            // Building passages, covered walkways, and lazy layer 0 tunnels are demoted to standard roads.
            let forceIsTunnel = isTunnel && layer < 0;
            let halfW = getRoadHalfWidth(props) + (isBridge ? 0.5 : 0);

            const hType = (props.highway || '').toLowerCase();

            // SURGICAL STRIKE 1: Instantly amputate all stairways/sloped ribbons
            if (hType === 'steps' || hType === 'corridor') {
                continue;
            }

            // Bridges cannot also be tunnels
            if (forceIsBridge) forceIsTunnel = false;

            // LOOP 2 ONLY PROCESSES: ground roads, stairs, and surface tunnels
            if (forceIsBridge || forceIsTunnel) {
                continue; // Skip bridges and deep tunnels in Loop 2 (already processed in Loop 1)
            }
            
            const priorityOffset = (hType === 'motorway' || hType === 'trunk') ? 0.6 : (hType === 'primary' || hType === 'secondary') ? 0.4 : 0.2;
            const hasMarkings = hType !== 'footway' && hType !== 'path' && hType !== 'pedestrian' &&
                                 hType !== 'cycleway' && hType !== 'steps' && hType !== 'track';

            const coordsArray = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                const projPts = [];
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const proj = project(pt[0], pt[1]);
                    if (proj.valid) projPts.push(proj);
                }
                if (projPts.length < 2) continue;

                    // Ground road — includes building_passage and covered=yes, which are surface roads
                    // that just happen to pass under a building arch or cover. No special handling.
                    void isBuildingPassage; void isCovered;
                    
                    // Special handling for steps: use new buildStaircase with dynamic altitude anchoring
                    const isSidewalk = hType === 'footway' || hType === 'path' || hType === 'pedestrian' || hType === 'cycleway' || hType === 'steps';
                    const yOffset = isSidewalk ? 0.15 : 0.3;
                    let geometry;
                        // THE FIX: Push layer offset into the ribbon sampler
                        const layerOffset = layer > 0 ? (layer * 5.0) + priorityOffset : 0;
                        const finalPts = cleanAndResample(projPts, 4.0, (x, z) => getBridgeAwareY(x, z) + yOffset + layerOffset);
                        smoothElevations(finalPts, 3);
                        geometry = buildSmoothRibbon(finalPts, halfW, hasMarkings);
                    
                    if (geometry) {
                        (isSidewalk ? sidewalkGroundGeos : roadGroundGeos).push(geometry);
                    }
            }
        }
        if (roadGroundGeos.length > 0) await safeMassMerge(roadGroundGeos, matRoadGround, Engine.groups.roads, 'road', false);
        if (sidewalkGroundGeos.length > 0) await safeMassMerge(sidewalkGroundGeos, matSidewalkGround, Engine.groups.roads, 'sidewalk', false);
        if (roadBridgeGeos.length > 0) await safeMassMerge(roadBridgeGeos, matRoadBridge, Engine.groups.roads, 'road', true);
        if (sidewalkBridgeGeos.length > 0) await safeMassMerge(sidewalkBridgeGeos, matSidewalkBridge, Engine.groups.roads, 'sidewalk', true);
        if (roadTunnelGeos.length > 0) await safeMassMerge(roadTunnelGeos, matTunnelInterior, Engine.groups.tunnels, 'tunnel', false);
        if (roadTunnelPortalGeos.length > 0) await safeMassMerge(roadTunnelPortalGeos, matTunnelPortal, Engine.groups.tunnels, 'tunnelPortal', true);
        if (roadTunnelStripGeos.length > 0) await safeMassMerge(roadTunnelStripGeos, matTunnelStrip, Engine.groups.tunnelLights, 'tunnelStrip', false);
        console.log(`[Roads] tunnelGeos=${roadTunnelGeos.length} portalGeos=${roadTunnelPortalGeos.length} portalHoles=${Engine.portalHoles.count}/${Engine.portalHoles.maxHoles}`);
        let surfaceHoles = 0, deepHoles = 0;
        for (let i = 0; i < Engine.portalHoles.count; i++) {
            if (Engine.portalHoles.data[i].z < 0) surfaceHoles++; else deepHoles++;
        }
        console.log(`[Roads] Portal holes: ${surfaceHoles} surface (building cuts), ${deepHoles} deep (terrain cuts)`);
        if (Engine.portalHoles.count > 0) {
            const h = Engine.portalHoles.data[0];
            console.log(`[Roads] First hole: x=${h.x.toFixed(1)} z=${h.y.toFixed(1)} r=${h.z.toFixed(1)} topY=${h.w.toFixed(1)}`);
        }
    }

    // --- RAILWAYS ---
    updateLoader(3, 8, 'Railways');
    let railData = await fetchLayer(pfx + 'combined_railways.geojson');
    const railNodes = new Map();

    if (railData?.features) {
        for (const feature of railData.features) {
            if (!feature.geometry || !feature.geometry.type.includes('LineString')) continue;
            const isBridge = feature.properties?.bridge === 'yes';
            const isTunnel = feature.properties?.tunnel === 'yes';
            const coordsArray = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const key = `${pt[0].toFixed(5)}_${pt[1].toFixed(5)}`;
                    if (!railNodes.has(key)) railNodes.set(key, { bridge: false, ground: false, tunnel: false });
                    if (isBridge) railNodes.get(key).bridge = true;
                    else if (isTunnel) railNodes.get(key).tunnel = true;
                    else railNodes.get(key).ground = true;
                }
            }
        }
    }

    if (railData?.features) {
        const railGroundGeos = [];
        const railBridgeGeos = [];
        const railTunnelGeos = [];
        const railTunnelPortalGeos = [];
        const railTunnelStripGeos = [];

        for (const feature of railData.features) {
            if (!feature.geometry || !feature.geometry.type.includes('LineString')) continue;
            const rProps = feature.properties || {};
            const isTunnel = rProps.tunnel === 'yes';

            const isBridge = rProps.bridge === 'yes';
            const layer = parseFloat(rProps.layer) || (isBridge ? 1 : isTunnel ? -1 : 0);
            const railPriority = rProps.railway === 'main' ? 0.3 : 0.1;

            const coordsArray = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                const projPts = [];
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const proj = project(pt[0], pt[1]);
                    if (proj.valid) projPts.push(proj);
                }
                if (projPts.length < 2) continue;

                if (isBridge) {
                    const pStart = projPts[0], pEnd = projPts[projPts.length - 1];
                    const startY = getElevationAt(pStart.x, -pStart.y), endY = getElevationAt(pEnd.x, -pEnd.y);

                    const hOffset = (layer > 0 ? (layer * 5.0) + railPriority : 6.0 + railPriority);
                    const startKey = `${path[0][0].toFixed(5)}_${path[0][1].toFixed(5)}`;
                    const endKey = `${path[path.length-1][0].toFixed(5)}_${path[path.length-1][1].toFixed(5)}`;

                    const taperStart = railNodes.get(startKey)?.ground === true;
                    const taperEnd = railNodes.get(endKey)?.ground === true;

                    const bridge = buildVolumetricBridge(projPts, startY, endY, hOffset, 1.5, taperStart, taperEnd, 0.8 + railPriority);
                    if (bridge) {
                        if (bridge.deckGeo) railBridgeGeos.push(bridge.deckGeo);
                        if (bridge.pierGeo) railBridgeGeos.push(bridge.pierGeo);
                    }
                } else if (isTunnel) {
                    const isSubway = (rProps.railway === 'subway');
                    // Subway: 5.5 m — enough for a full metro car (3.8 m) + overhead structure
                    // Heavy/main rail: 7.0 m for standard gauge rolling stock
                    const clearance = isSubway ? 4.5 : 5.5;
                    const railHalfW = isSubway ? 3.0 : 2.8;
                    // Rail tunnels need more depth for ballast + track bed
                    const depthOffset = clearance + 1.5;

                    const startKey = `${path[0][0].toFixed(5)}_${path[0][1].toFixed(5)}`;
                    const endKey = `${path[path.length-1][0].toFixed(5)}_${path[path.length-1][1].toFixed(5)}`;

                    const startNodeR = railNodes.get(startKey);
                    const endNodeR   = railNodes.get(endKey);
                    const taperStart = startNodeR?.ground === true || startNodeR?.bridge === true;
                    const taperEnd   = endNodeR?.ground   === true || endNodeR?.bridge   === true;
                    const nsTunnel   = !taperStart && startNodeR?.tunnel === true;
                    const neTunnel   = !taperEnd   && endNodeR?.tunnel   === true;

                    const tunnel = buildVolumetricTunnel(projPts, railHalfW, clearance, depthOffset, taperStart, taperEnd, nsTunnel, neTunnel);
                    if (tunnel) {
                        if (tunnel.tubeGeo)   railTunnelGeos.push(tunnel.tubeGeo);
                        if (tunnel.portalGeo) railTunnelPortalGeos.push(tunnel.portalGeo);
                        if (tunnel.stripGeo)  railTunnelStripGeos.push(tunnel.stripGeo);
                    }
                } else {
                    const finalPts = cleanAndResample(projPts, 4.0, (x, z) => getElevationAt(x, z) + 0.15);
                    smoothElevations(finalPts, 2);
                    const ribbon = buildSmoothRibbon(finalPts, 1.5);
                    if (ribbon) railGroundGeos.push(ribbon);
                }
            }
        }
        if (railGroundGeos.length > 0) await safeMassMerge(railGroundGeos, matRailGround, Engine.groups.rails, 'rail', false);
        if (railBridgeGeos.length > 0) await safeMassMerge(railBridgeGeos, matRailBridge, Engine.groups.rails, 'rail', true);
        if (railTunnelGeos.length > 0) await safeMassMerge(railTunnelGeos, matTunnelInterior, Engine.groups.tunnels, 'tunnel', false);
        if (railTunnelPortalGeos.length > 0) await safeMassMerge(railTunnelPortalGeos, matTunnelPortal, Engine.groups.tunnels, 'tunnelPortal', true);
        if (railTunnelStripGeos.length > 0) await safeMassMerge(railTunnelStripGeos, matTunnelStrip, Engine.groups.tunnelLights, 'tunnelStrip', false);
    }

    // --- SKI INFRASTRUCTURE ---
    updateLoader(4, 8, 'Ski Infrastructure');
    let skiData = await fetchLayer(pfx + 'combined_ski.geojson');
    if (skiData?.features) {
        const skiRunGeos = [];
        const skiRunWires = [];
        const skiLiftGeos = [];
        const skiLiftWires = [];
        const skiPylonGeos = [];
        const skiPylonWires = [];

        for (const feature of skiData.features) {
            if (!feature.geometry) continue;
            const props = feature.properties || {};
            const isLift = !!props.aerialway;

            const gt = feature.geometry.type;

            if (!isLift) continue;
            if (gt !== 'LineString' && gt !== 'MultiLineString') continue;

            const coordsArray = gt === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;

            for (const path of coordsArray) {
                const projPts = [];
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const proj = project(pt[0], pt[1]);
                    if (proj.valid) projPts.push(proj);
                }
                if (projPts.length < 2) continue;

                if (isLift) {
                    const liftPts = [];
                    for (let i = 0; i < projPts.length; i++) {
                        const p = projPts[i];
                        const y = getElevationAt(p.x, -p.y) + 15.0; 
                        liftPts.push(new THREE.Vector3(p.x, y, -p.y));
                    }

                    const sampledPts = [];
                    for (let i = 0; i < liftPts.length - 1; i++) {
                        const p1 = liftPts[i];
                        const p2 = liftPts[i+1];
                        const dist = p1.distanceTo(p2);
                        const segments = Math.max(1, Math.ceil(dist / 2)); 

                        for(let j = 0; j <= segments; j++) {
                            if (j === segments && i < liftPts.length - 2) continue; 
                            const t = j / segments;
                            const pt = new THREE.Vector3().lerpVectors(p1, p2, t);
                            pt.isBridgeDeck = true; 
                            sampledPts.push(pt);
                        }
                    }

                    if (sampledPts.length < 2) continue;

                    const ribbon = buildSmoothRibbon(sampledPts, 0.05); 
                    if (ribbon) { 
                        ribbon.computeVertexNormals(); 
                        skiLiftGeos.push(ribbon); 
                        skiLiftWires.push(new THREE.EdgesGeometry(ribbon, 30));
                    }

                    let distSincePylon = 0;
                    let distSinceChair = 0;

                    for (let i = 0; i < sampledPts.length - 1; i++) {
                        const p1 = sampledPts[i];
                        const p2 = sampledPts[i+1];
                        const d = p1.distanceTo(p2);

                        distSincePylon += d;
                        distSinceChair += d;

                        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
                        const angle = Math.atan2(dir.x, dir.z);

                        if (distSincePylon >= 60) {
                            distSincePylon = 0;
                            const groundY = getElevationAt(p2.x, p2.z);
                            const pylonH = p2.y - groundY;

                            if (pylonH > 1) {
                                const pylon = new THREE.BoxGeometry(0.4, pylonH, 0.4);
                                const crossbar = new THREE.BoxGeometry(3.0, 0.4, 0.4);
                                crossbar.translate(0, pylonH / 2, 0);
                                crossbar.rotateY(angle + Math.PI / 2); 

                                const mergedPylon = BufferGeometryUtils.mergeBufferGeometries([pylon, crossbar]);
                                mergedPylon.deleteAttribute('uv');
                                
                                // THE FIX: Normalize attributes to match the ribbon cable
                                const pCount = mergedPylon.attributes.position.count;
                                mergedPylon.setAttribute('roadUV', new THREE.Float32BufferAttribute(new Float32Array(pCount * 2), 2));
                                mergedPylon.setAttribute('roadED', new THREE.Float32BufferAttribute(new Float32Array(pCount), 1));
                                
                                mergedPylon.translate(p2.x, groundY + pylonH / 2, p2.z);
                                skiPylonGeos.push(mergedPylon);
                                skiPylonWires.push(new THREE.EdgesGeometry(mergedPylon, 30));
                            }
                        }

                        if (distSinceChair >= 15) {
                            distSinceChair = 0;
                            if (distSincePylon < 2 || distSincePylon > 58) continue;

                            const chair = new THREE.BoxGeometry(1.2, 0.8, 0.8);
                            chair.translate(0, -1.8, 0); 

                            const arm = new THREE.CylinderGeometry(0.05, 0.05, 1.5);
                            arm.translate(0, -0.75, 0);

                            const mergedChair = BufferGeometryUtils.mergeBufferGeometries([chair, arm]);
                            mergedChair.deleteAttribute('uv');
                            
                            // THE FIX: Normalize attributes to match the ribbon cable
                            const cCount = mergedChair.attributes.position.count;
                            mergedChair.setAttribute('roadUV', new THREE.Float32BufferAttribute(new Float32Array(cCount * 2), 2));
                            mergedChair.setAttribute('roadED', new THREE.Float32BufferAttribute(new Float32Array(cCount), 1));
                            
                            mergedChair.rotateY(angle);
                            mergedChair.translate(p2.x, p2.y, p2.z);

                            skiPylonGeos.push(mergedChair);
                            skiPylonWires.push(new THREE.EdgesGeometry(mergedChair, 30));
                        }
                    }
                }
            }
        }

        if (skiRunGeos.length > 0) {
            await safeMassMerge(skiRunGeos, matSkiRun, Engine.groups.ski, 'skiRun', false);
            await safeMassMergeWires(skiRunWires, matGroundLine, Engine.groups.ski, 'skiRun');
        }
        const combinedLifts = [...skiLiftGeos, ...skiPylonGeos];
        const combinedLiftWires = [...skiLiftWires, ...skiPylonWires];
        if (combinedLifts.length > 0) {
            await safeMassMerge(combinedLifts, matSkiLift, Engine.groups.ski, 'skiLift', true);
            await safeMassMergeWires(combinedLiftWires, matGroundLine, Engine.groups.ski, 'skiLift');
        }
    }


    updateLoader(5, 8, 'Terrain Textures');
    let [zData, pData, vData, wData, hData] = await Promise.all([
        fetchLayer(pfx + 'combined_zoning.geojson'),
        fetchLayer(pfx + 'combined_parks.geojson'),
        fetchLayer(pfx + 'combined_veg.geojson'),
        fetchLayer(pfx + 'combined_water.geojson'),
        fetchLayer(pfx + 'combined_hardscape.geojson'),
    ]);
    {
        const r = Engine.meta.radius || 1000;
        const groundTex = bakeTerrainTexture(zData, pData, vData, wData, skiData, hData, r, Engine.currentTheme);
        matTopoFill.map = groundTex;
        matTopoFill.needsUpdate = true;
    }

    if (_topoGrid) {
        const SIZE     = _topoGrid.size;               
        const worldSz  = _topoWorldSize;
        const planeGeo = new THREE.PlaneGeometry(worldSz, worldSz, SIZE - 1, SIZE - 1);
        planeGeo.rotateX(-Math.PI / 2);

        const posArr = planeGeo.attributes.position.array;
        for (let j = 0; j < SIZE; j++) {
            for (let i = 0; i < SIZE; i++) {
                posArr[(j * SIZE + i) * 3 + 1] = _topoGrid.data[j * SIZE + i];
            }
        }
        planeGeo.attributes.position.needsUpdate = true;
        planeGeo.computeVertexNormals();  
        const terrainMesh = new THREE.Mesh(planeGeo, plinthClone(matTopoFill));
        terrainMesh.receiveShadow = true;
        terrainMesh.matrixAutoUpdate = false;
        terrainMesh.updateMatrix();
        Engine.groups.topo.add(terrainMesh);
    }

    updateLoader(6, 8, 'Vegetation');
    initVegetation(vData, sData, railData);

    Engine.geoCache.zData   = zData;
    Engine.geoCache.pData   = pData;
    Engine.geoCache.vData   = vData;
    Engine.geoCache.wData   = wData;
    Engine.geoCache.skiData = skiData;
    Engine.geoCache.hData   = hData;
    zData = null; pData = null; vData = null; wData = null; hData = null;

    updateLoader(7, 8, 'Micro Detail & Labels');
    let mData = await fetchLayer(pfx + 'combined_micro.geojson');
    if (mData?.features) {

        const treeFeatures = [];
        const lampFeatures = []; 
        const nonTreeFeatures = [];

        for (const f of mData.features) {
            const nat = f.properties?.natural;
            const hw = f.properties?.highway;
            const gt = f.geometry?.type;
            if (nat === 'tree' || nat === 'tree_row' || nat === 'shrub') {
                treeFeatures.push(f);
            } else if (hw === 'street_lamp') {
                lampFeatures.push(f);
            } else {
                nonTreeFeatures.push(f);
            }

            const mm = f.properties?.man_made;
            const aw = f.properties?.aeroway;
            if (gt === 'Point' && (mm === 'mast' || mm === 'tower' || mm === 'wind_turbine' || aw === 'navigationaid')) {
                const c = f.geometry.coordinates;
                const proj = project(c[0], c[1]);
                if (proj.valid) {
                    const h = parseFloat(f.properties?.height) || 30; 
                    const y = getBridgeAwareY(proj.x, -proj.y);
                    aviationBeaconPts.push({ x: proj.x, y: y + h, z: -proj.y, id: Math.random() });
                }
            }
        }

        mData.features = nonTreeFeatures;

        // Snap micro-details to bridge decks when they sit over one.
        function getBridgeAwareY(x, z) {
            const structs = getStructureAt(x, z);
            let bridgeY = -Infinity;
            for (const s of structs) {
                if ((s.type === 'bridge' || s.type === 'bridgePoly') && s.yTop > bridgeY) bridgeY = s.yTop;
            }
            return bridgeY > -Infinity ? bridgeY : getElevationAt(x, z);
        }

        if (Engine.treeMesh && treeFeatures.length > 0) {
            const explicitTreeCoords = [];

            for (const f of treeFeatures) {
                const gt = f.geometry?.type;
                if (gt === 'Point') {
                    explicitTreeCoords.push(f.geometry.coordinates);
                } else if (gt === 'LineString') {
                    const pts = f.geometry.coordinates;
                    for (let i = 0; i < pts.length - 1; i++) {
                        const p1 = project(pts[i][0], pts[i][1]);
                        const p2 = project(pts[i+1][0], pts[i+1][1]);
                        if (!p1.valid || !p2.valid) continue;

                        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                        const steps = Math.max(1, Math.floor(dist / 6.0));

                        for (let j = 0; j <= steps; j++) {
                            const t = j / steps;
                            explicitTreeCoords.push([
                                pts[i][0] + (pts[i+1][0] - pts[i][0]) * t,
                                pts[i][1] + (pts[i+1][1] - pts[i][1]) * t
                            ]);
                        }
                    }
                }
            }

            if (explicitTreeCoords.length > 0) {
                const expTreeMesh = new THREE.InstancedMesh(
                    Engine.treeMesh.geometry,
                    Engine.treeMesh.material,
                    explicitTreeCoords.length
                );
                expTreeMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
                expTreeMesh.castShadow = true;
                expTreeMesh.receiveShadow = true;
                expTreeMesh.userData.colorKey = 'tree';
                expTreeMesh.frustumCulled = false; 

                const dummy = new THREE.Object3D();
                const radius = Engine.meta?.radius || 1000;
                let added = 0;

                for (const pt of explicitTreeCoords) {
                    const proj = project(pt[0], pt[1]);
                    if (!proj.valid) continue;
                    if (Math.hypot(proj.x, proj.y) > radius) continue;

                    const y = getBridgeAwareY(proj.x, -proj.y);
                    const scale = 0.5 + Math.random() * 1.0;

                    dummy.position.set(proj.x, y, -proj.y);
                    dummy.scale.set(scale, scale, scale);
                    dummy.rotation.y = Math.random() * Math.PI * 2;
                    dummy.updateMatrix();
                    expTreeMesh.setMatrixAt(added++, dummy.matrix);
                }

                expTreeMesh.count = added;
                expTreeMesh.instanceMatrix.needsUpdate = true;
                Engine.groups.micro.add(expTreeMesh);
                console.log(`  Spawned ${added} permanent explicit OSM trees.`);
            }
        }

        if (lampFeatures.length > 0) {
            const poleGeo = new THREE.CylinderGeometry(0.1, 0.15, 6, 4);
            poleGeo.translate(0, 3, 0);
            applyVertexColors(poleGeo, 0x111111); 

            const bulbGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
            bulbGeo.translate(0, 6.0, 0);
            applyVertexColors(bulbGeo, 0xffffff); 

            const baseLampGeo = BufferGeometryUtils.mergeBufferGeometries([poleGeo, bulbGeo]);
            poleGeo.dispose(); bulbGeo.dispose();

            const matLamp = new THREE.MeshBasicMaterial({ vertexColors: true });
            matLamp.onBeforeCompile = applyBaseShader;

            const lampMesh = new THREE.InstancedMesh(baseLampGeo, matLamp, lampFeatures.length);
            lampMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
            grad.addColorStop(0.3, 'rgba(255, 255, 240, 0.6)');
            grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
            const flareTex = new THREE.CanvasTexture(canvas);

            Engine.matLampFlare = new THREE.PointsMaterial({
                size: 4,
                sizeAttenuation: false,
                map: flareTex,
                transparent: true,
                opacity: 0.0,
                blending: THREE.AdditiveBlending,
                depthWrite: true,
                depthTest: true
            });

            const flarePositions = new Float32Array(lampFeatures.length * 3);
            const dummy = new THREE.Object3D();
            const radius = Engine.meta?.radius || 1000;
            let added = 0;

            for (const f of lampFeatures) {
                const pt = f.geometry.coordinates;
                const proj = project(pt[0], pt[1]);
                if (!proj.valid || Math.hypot(proj.x, proj.y) > radius) continue;

                const y = getBridgeAwareY(proj.x, -proj.y);

                dummy.position.set(proj.x, y, -proj.y);
                dummy.updateMatrix();
                lampMesh.setMatrixAt(added, dummy.matrix);

                flarePositions[added * 3]     = proj.x;
                flarePositions[added * 3 + 1] = y + 6.0;
                flarePositions[added * 3 + 2] = -proj.y;

                added++;
            }

            lampMesh.count = added;
            lampMesh.instanceMatrix.needsUpdate = true;
            Engine.groups.lights.add(lampMesh);

            const flareGeo = new THREE.BufferGeometry();
            flareGeo.setAttribute('position', new THREE.BufferAttribute(flarePositions.slice(0, added * 3), 3));
            const flarePoints = new THREE.Points(flareGeo, Engine.matLampFlare);
            flarePoints.frustumCulled = false;
            Engine.groups.lights.add(flarePoints);
        }

        function microColorKey(feature) {
            const p = feature.properties || {};
            if (p.natural === 'tree' || p.natural === 'tree_row' || p.natural === 'shrub') return 'forest';
            if (p.natural === 'rock') return 'terrain';
            if (p.barrier === 'hedge') return 'scrub';
            if (p.man_made === 'sign' || p.tourism === 'artwork') return 'furniture';
            return 'road';
        }

        function microDepth(feature) {
            const p = feature.properties || {};
            if (p.height) return parseFloat(p.height);
            if (p.man_made === 'sign' || p.tourism === 'artwork') return 14;
            if (p.barrier) return 1.2;
            return 0;
        }

        const inscriptionFeatures = mData.features.filter(f =>
            f.properties?.inscription && f.properties.inscription !== 'null' &&
            (f.geometry?.type === 'Point' || f.geometry?.type === 'LineString')
        );
        const _inscriptionFont = await _inscriptionFontPromise;
        if (inscriptionFeatures.length > 0 && _inscriptionFont) {
            const letterDepth  = 1.2;   
            let renderedCount = 0;
            for (const feature of inscriptionFeatures) {
                const letter = feature.properties.inscription;

                if (feature.geometry.type === 'Point') continue;

                const c = feature.geometry.coordinates;
                const startPos = project(c[0][0], c[0][1]);
                const endPos   = project(c[c.length - 1][0], c[c.length - 1][1]);
                if (!startPos.valid || !endPos.valid) continue;
                const spanDist = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
                const letterHeight = spanDist / letter.length;

                if (letterHeight < 5.0) continue;

                const rawCoords = [(c[0][0] + c[c.length - 1][0]) / 2,
                                   (c[0][1] + c[c.length - 1][1]) / 2];
                const pos = project(rawCoords[0], rawCoords[1]);
                if (!pos.valid) continue;

                const terrainY = getBridgeAwareY(pos.x, -pos.y);

                const textGeo = new THREE.TextGeometry(letter, {
                    font: _inscriptionFont,
                    size: letterHeight,
                    height: letterDepth,
                    curveSegments: 24,
                    bevelEnabled: false,
                });
                textGeo.computeBoundingBox();
                const bb = textGeo.boundingBox;
                const cx = (bb.max.x - bb.min.x) / 2;
                textGeo.translate(-cx, 0, 0);

                // THE FIX: Stop cloning materials for every letter
                const mesh = new THREE.Mesh(textGeo, matFill);
                mesh.castShadow    = true;
                mesh.receiveShadow = true;
                mesh.userData.colorKey = 'bFill';
                mesh.position.set(pos.x, terrainY, -pos.y);
                mesh.rotation.y = Math.PI; 
                mesh.scale.x = -1;         
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                Engine.groups.micro.add(mesh);
                renderedCount++;
            }
            console.log(`  Rendered ${renderedCount} inscription letter(s) as 3D text (${inscriptionFeatures.length - renderedCount} culled).`);
        }

        const microPolyData = { features: mData.features.filter(f =>
            (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') &&
            !f.properties?.inscription &&
            !f.properties?.barrier
        )};
        buildPolygonLayer(microPolyData, Engine.groups.micro, 0.1, microDepth, matFill, microColorKey, null, getBridgeAwareY);

        const microLineGeos = [];
        for (const feature of mData.features) {
            if (!feature.geometry) continue;
            if (feature.properties?.inscription) continue;
            const gt = feature.geometry.type;
            if (gt !== 'LineString' && gt !== 'MultiLineString') continue;

            const coordsArray = gt === 'LineString'
                ? [feature.geometry.coordinates]
                : feature.geometry.coordinates;
            for (const path of coordsArray) {
                const projPts = [];
                for (const pt of path) {
                    if (!pt || pt.length < 2) continue;
                    const proj = project(pt[0], pt[1]);
                    if (proj.valid) projPts.push(proj);
                }
                const cleaned = cleanAndResample(projPts, 0.3, (x, z) => getBridgeAwareY(x, z) + 0.2, 2);
                if (cleaned.length > 1) {
                    const p = feature.properties || {};
                    const h = parseFloat(p.height) || ((p.man_made === 'sign' || p.tourism === 'artwork') ? 14 : 0);

                    let meshGeo;
                    if (h > 0) {
                        meshGeo = buildVerticalWall(cleaned, h);
                    } else {
                        meshGeo = buildSmoothRibbon(cleaned, 0.3);
                    }
                    if (meshGeo) microLineGeos.push(meshGeo);
                }
            }
        }
        if (microLineGeos.length > 0) {
            const merged = BufferGeometryUtils.mergeBufferGeometries(microLineGeos);
            microLineGeos.forEach(g => g.dispose());
            if (merged) {
                const lineMesh = new THREE.Mesh(merged, plinthClone(matFill));
                lineMesh.userData.colorKey = 'road';
                lineMesh.matrixAutoUpdate = false; lineMesh.updateMatrix();
                Engine.groups.micro.add(lineMesh);
            }
        }
    }
    mData = null;

    let lblData = await fetchLayer(pfx + 'combined_labels.geojson');
    Engine.labels = lblData?.features ?? [];
    lblData = null;

    Engine.groups.topo.children.forEach(m =>  { m.renderOrder = -1; m.material.depthWrite = true; m.material.transparent = false; });
    Engine.groups.zones.children.forEach(m => { m.renderOrder = 0; m.material.depthWrite = true; m.material.transparent = false; });
    Engine.groups.parks.children.forEach(m => { m.renderOrder = 1; m.material.depthWrite = false; m.material.transparent = true; });
    Engine.groups.veg.children.forEach(m =>   { m.renderOrder = 2; m.material.depthWrite = false; m.material.transparent = true; });
    Engine.groups.water.children.forEach(m => { m.renderOrder = 3; m.material.depthWrite = true; m.material.transparent = false; });
    Engine.groups.roads.children.forEach(m => { m.renderOrder = m.userData.colorKey === 'sidewalk' ? 3.5 : 4; });
    Engine.groups.rails.children.forEach(m => { m.renderOrder = 4; });
    Engine.groups.ski.children.forEach(m => { m.renderOrder = 4; });
    Engine.groups.micro.children.forEach(m => { m.renderOrder = 5; m.material.depthWrite = true; m.material.transparent = false; });
    Engine.groups.bFill.children.forEach(m => { m.renderOrder = 6; });
    for (const grp of [Engine.groups.bWire, Engine.groups.roofs, Engine.groups.detail]) {
        grp.children.forEach(m => { m.renderOrder = 7; });
    }
    Engine.groups.lights.children.forEach(m => { m.renderOrder = 10; });

    updateLoader(8, 8, 'Complete');
    updateStyles();
    hideLoader();
}

function isConvex(pts) {
    if (pts.length < 4) return true;
    let sign = 0;
    const n = pts.length;
    const count = (pts[0].x === pts[n-1].x && pts[0].y === pts[n-1].y) ? n - 1 : n;

    for (let i = 0; i < count; i++) {
        const dx1 = pts[(i + 1) % count].x - pts[i].x;
        const dy1 = pts[(i + 1) % count].y - pts[i].y;
        const dx2 = pts[(i + 2) % count].x - pts[(i + 1) % count].x;
        const dy2 = pts[(i + 2) % count].y - pts[(i + 1) % count].y;
        const cp  = dx1 * dy2 - dy1 * dx2;

        if (cp !== 0) {
            if (sign === 0) sign = cp > 0 ? 1 : -1;
            else if ((cp > 0 ? 1 : -1) !== sign) return false;
        }
    }
    return true;
}

function buildRoofGeometry(pts, h, roofShape, roofH) {
    if (!pts || pts.length < 3) return null;

    if (!isConvex(pts)) return null;

    let cx = 0, cz = 0;
    const n = pts.length;
    for (const p of pts) { cx += p.x; cz += p.y; }
    cx /= n; cz /= n;

    let maxR = 0;
    for (const p of pts) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.y - cz));
    if (maxR < 0.5) return null;

    const rh = roofH > 0 ? roofH : Math.max(1.5, maxR * 0.35);

    if (roofShape === 'dome' || roofShape === 'onion') {
        const r = Math.min(maxR, rh);
        const geo = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        geo.translate(cx, h, -cz);
        return geo;
    }

    if (roofShape === 'cone') {
        const geo = new THREE.ConeGeometry(maxR * 0.85, rh, 16);
        geo.translate(cx, h + rh / 2, -cz);
        return geo;
    }

    if (roofShape === 'pyramidal' || roofShape === 'pyramid' ||
        roofShape === 'gabled'    || roofShape === 'gable'   ||
        roofShape === 'hipped'    || roofShape === 'hip'     ||
        roofShape === 'gambrel'   || roofShape === 'mansard') {

        const count = n - 1;
        const verts = new Float32Array(count * 9);
        for (let i = 0; i < count; i++) {
            const a = pts[i], b = pts[(i + 1) % count];
            verts.set([a.x, h, -a.y,  b.x, h, -b.y,  cx, h + rh, -cz], i * 9);
        }
        let geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.computeVertexNormals();
        geo = BufferGeometryUtils.mergeVertices(geo, 1e-4);
        return geo;
    }

    return null;
}

function buildWindowLines(pts, h, levels, minH = 0) {
    const winPts = [];
    const floorHeight = 3.5;
    const actualLevels = levels > 0 ? levels : Math.floor((h - minH) / floorHeight);

    for (let k = 0; k < pts.length - 1; k++) {
        const p1 = pts[k], p2 = pts[k + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const segLen = Math.hypot(dx, dy);

        if (segLen < 6 || isNaN(segLen)) continue;

        const cols = Math.floor(segLen / 16);
        for (let m = 1; m < cols; m++) {
            const ratio = m / cols;
            const px = p1.x + dx * ratio;
            const pz = -(p1.y + dy * ratio);
            winPts.push(
                new THREE.Vector3(px, minH, pz),
                new THREE.Vector3(px, h, pz)
            );
        }

        if (actualLevels > 4) {
            for (let lvl = 4; lvl < actualLevels; lvl += 4) {
                const ly = minH + lvl * ((h - minH) / actualLevels);
                winPts.push(
                    new THREE.Vector3(p1.x, ly, -p1.y),
                    new THREE.Vector3(p2.x, ly, -p2.y)
                );
            }
        }
    }
    return winPts;
}

export function processGLB(modelScene, assetId) {
    modelScene.updateMatrixWorld(true);

    const globalBox = new THREE.Box3();
    const meshes    = [];

    modelScene.traverse(child => {
        if (!child.isMesh) return;
        const geom = child.geometry.clone();
        geom.applyMatrix4(child.matrixWorld);
        geom.computeBoundingBox();
        globalBox.union(geom.boundingBox);
        meshes.push(geom);
    });
    if (meshes.length === 0) return;

    const sizeY = globalBox.max.y - globalBox.min.y;
    if (isNaN(sizeY) || sizeY === 0) return;

    const thresholdY     = globalBox.min.y + sizeY * 0.5;
    const upperBox       = new THREE.Box3();
    let   validUpperPts  = false;

    for (const mesh of meshes) {
        const pos = mesh.attributes.position;
        if (!pos) continue;
        for (let i = 0; i < pos.count; i++) {
            const vY = pos.getY(i);
            if (vY > thresholdY && !isNaN(vY)) {
                const vX = pos.getX(i), vZ = pos.getZ(i);
                if (!isNaN(vX) && !isNaN(vZ)) { upperBox.expandByPoint(new THREE.Vector3(vX, vY, vZ)); validUpperPts = true; }
            }
        }
    }

    const trueCenter = new THREE.Vector3();
    if (validUpperPts && upperBox.min.x !== Infinity) upperBox.getCenter(trueCenter);
    else globalBox.getCenter(trueCenter);
    if (isNaN(trueCenter.x) || isNaN(trueCenter.y) || isNaN(trueCenter.z)) trueCenter.set(0, 0, 0);

    const normalizeScale = sizeY > 0 ? 1.0 / sizeY : 1.0;
    const fillGroup = new THREE.Group();
    const wireGroup = new THREE.Group();

    for (const geom of meshes) {
        geom.translate(-trueCenter.x, -globalBox.min.y, -trueCenter.z);
        geom.scale(normalizeScale, normalizeScale, normalizeScale);

        const fillMat = new THREE.MeshStandardMaterial({
            color: Engine.currentTheme.bFill,
            transparent: true,
            roughness: 0.8,
            metalness: 0.1,
            clippingPlanes: [Engine.heroClipPlane],
            polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 8,
        });

        registerCSMMaterial(fillMat);
        const csmCompileHero = fillMat.onBeforeCompile;
        fillMat.onBeforeCompile = (shader, renderer) => {
            applyBaseShader(shader);
            csmCompileHero(shader, renderer);
        };

        const wireMat = new LineMaterial({
            color:         Engine.currentTheme.ink,
            linewidth:     2.0,
            transparent:   true,
            clippingPlanes: [Engine.heroClipPlane],
            clipping:      true,
            alphaToCoverage: true, 
        });
        const _heroRes = new THREE.Vector2();
        Engine.renderer.getSize(_heroRes);
        wireMat.resolution.copy(_heroRes);
        wireMat.onBeforeCompile = applyBaseShaderLine2;

        const fillMesh = new THREE.Mesh(geom, fillMat);
        fillMesh.castShadow = true;     
        fillMesh.receiveShadow = true;  

        fillGroup.add(fillMesh);
        wireGroup.add(new LineSegments2(edgesToLineGeo(new THREE.EdgesGeometry(geom, 85)), wireMat));
    }

    Engine.groups.heroFill.add(fillGroup);
    Engine.groups.heroWire.add(wireGroup);

    const initH = (assetId === 'hero_default' && Engine.heroState.found) ? Engine.heroState.h : 100;
    Engine.loadedAssets[assetId] = { fill: fillGroup, wire: wireGroup, h: initH, rot: 0, y: -3.5, x: 0, z: 0 };

    if (assetId !== 'hero_default') {
        const opt = document.createElement('option');
        opt.value = assetId; opt.innerText = assetId;
        const sel = document.getElementById('asset-select');
        if (sel) { sel.appendChild(opt); sel.value = assetId; sel.dispatchEvent(new Event('change')); }
    } else {
        applyAssetTransforms(assetId);
    }
}

export function applyAssetTransforms(assetId) {
    const ast = Engine.loadedAssets[assetId];
    if (!ast) return;

    ast.fill.scale.set(ast.h, ast.h, ast.h);
    ast.wire.scale.set(ast.h, ast.h, ast.h);

    const rad = ast.rot * (Math.PI / 180);
    ast.fill.rotation.y = rad;
    ast.wire.rotation.y = rad;

    const origin = project(Engine.meta.lon, Engine.meta.lat);
    const wX = origin.x + ast.x;
    const wZ = -origin.y - ast.z;

    const groundY = getElevationAt(wX, wZ);

    ast.fill.position.set(wX, groundY + ast.y, wZ);
    ast.wire.position.set(wX, groundY + ast.y, wZ);

    updateStyles();
}

export function loadInitialHeroAsset() {
    const loader = new GLTFLoader();
    const draco  = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.4.1/');
    loader.setDRACOLoader(draco);
    const assetPath = './' + (Engine.meta?.data_path || '') + 'hero_model.glb?v=' + Date.now();

    loader.load(
        assetPath,
        gltf => {
            const btn = document.getElementById('btnToggleEngine');
            if (btn) {
                btn.classList.remove('active');
                btn.innerText = 'HERO ENGINE: OFF (PURE MAP)';
                btn.style.backgroundColor = 'transparent';
                btn.style.color = 'var(--text)';
            }
            processGLB(gltf.scene, 'hero_default');
        },
        undefined,
        (err) => { console.error('[Vitro] Hero GLB failed to load from:', assetPath, err); }
    );
}

export function loadGLBFromBuffer(buffer, assetId) {
    disposeGroup(Engine.groups.heroFill);
    disposeGroup(Engine.groups.heroWire);
    const loader = new GLTFLoader();
    const draco  = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.4.1/');
    loader.setDRACOLoader(draco);
    loader.parse(
        buffer, '',
        gltf => processGLB(gltf.scene, assetId),
        err  => console.error(err)
    );
}

// ============================================================================
// STYLE CONTROLLER (AND UNIFORM UPDATER)
// ============================================================================

function updateFocusPoint(isHeroOn) {
    if (isHeroOn) {
        const origin = project(Engine.meta.lon, Engine.meta.lat);
        Engine.focusPoint.x =  origin.x;
        Engine.focusPoint.z = -origin.y;
    } else {
        let bestDist = Infinity;
        let closestMesh = null;
        for (const child of Engine.groups.bFill.children) {
            if (child.userData.px === undefined || child.userData.pz === undefined) continue;
            const d = Math.hypot(child.userData.px - Engine.center.x, child.userData.pz - Engine.center.z);
            if (d < bestDist) {
                bestDist = d;
                closestMesh = child;
            }
        }
        if (closestMesh) {
            Engine.focusPoint.x    = closestMesh.userData.px;
            Engine.focusPoint.z    = closestMesh.userData.pz;
            Engine.focusFeatureId  = closestMesh.userData.featureId;
        } else {
            Engine.focusPoint.x    = Engine.center.x;
            Engine.focusPoint.z    = Engine.center.z;
        }
    }
    
    // FIX: Actually update the uniform so the GPU shader AND CPU culling know where the plinth is!
    Engine.uniforms.uCenter.value.set(Engine.focusPoint.x, Engine.focusPoint.z);
}

export function updateStyles() {
    if (!Engine.scene || !Engine.renderer) return;

    const isHeroOn       = document.getElementById('btnToggleEngine')?.classList.contains('active') ?? false;
    const isIsolatedMode = document.getElementById('btnIsolate')?.classList.contains('active') ?? false;

    const sldHeroRad = document.getElementById('sldHero-Rad');
    if (sldHeroRad) {
        if (!isHeroOn) sldHeroRad.disabled = !isIsolatedMode;
        else sldHeroRad.disabled = false; 
    }

    updateFocusPoint(isHeroOn);

    const focusRad = parseFloat(document.getElementById('sldHero-Rad')?.value ?? '100');
    const bOp      = parseFloat(document.getElementById('sldB-Op')?.value     ?? '1.0');
    const wOp      = parseFloat(document.getElementById('sldW-Op')?.value     ?? '1.0');
    const sOp      = parseFloat(document.getElementById('sldS-Op')?.value     ?? '1.0');
    const lWt      = parseFloat(document.getElementById('sldLine')?.value     ?? '1.0');

    const zoom    = Engine.camera?.zoom ?? 1;
    const wireOp  = Math.min(1.0, Math.max(0.15, zoom * 0.5));
    const isBlueprint = (Engine.currentThemeName === 'blueprint');
    const killLines = (lWt === 0);

    const _rendSize = new THREE.Vector2();
    Engine.renderer.getSize(_rendSize);

    // --- BULLETPROOF CPU-SIDE PLINTH CULLING ---
    const plinthX = Engine.uniforms.uCenter.value.x;
    const plinthZ = Engine.uniforms.uCenter.value.y; // uCenter is a Vector2(X, Z)
    const plinthR = Engine.uniforms.uPlinthRadius.value;

    const isInsidePlinth = (mesh) => {
        // Failsafe: Let the shader handle massive Instanced forests
        if (mesh.isInstancedMesh) return true; 

        // Fast path for individual un-merged buildings
        if (mesh.userData.px !== undefined && mesh.userData.pz !== undefined) {
            const dx = mesh.userData.px - plinthX;
            const dz = mesh.userData.pz - plinthZ;
            return Math.hypot(dx, dz) <= (plinthR + 100); // 100m padding for building width
        }

        // Fast geometry-level AABB check (Ignores THREE.js visible flags!)
        if (!mesh.geometry) return true;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        if (!box || box.isEmpty()) return true;

        // AABB-to-Circle intersection on the XZ plane
        const closestX = Math.max(box.min.x, Math.min(plinthX, box.max.x));
        const closestZ = Math.max(box.min.z, Math.min(plinthZ, box.max.z));
        
        const dx = closestX - plinthX;
        const dz = closestZ - plinthZ;
        
        return Math.hypot(dx, dz) <= plinthR;
    };
    // -------------------------------------------

    for (const grp of [Engine.groups.bFill, Engine.groups.bWire, Engine.groups.roofs, Engine.groups.detail]) {
        for (const child of grp.children) {
            
            // HARD CULL: Outside the plinth radius
            if (!isInsidePlinth(child)) {
                child.visible = false;
                continue; 
            }

            const isWire = isWireObject(child);

            // HARD CULL: Wires turned off
            if (isWire && killLines) {
                child.visible = false;
                continue; 
            }

            let dist = Infinity;
            if (child.userData.px !== undefined && child.userData.pz !== undefined) {
                dist = Math.hypot(child.userData.px - Engine.focusPoint.x, child.userData.pz - Engine.focusPoint.z);
            }

            if (isHeroOn) {
                child.visible = dist >= focusRad;
                if (child.userData.isGhost) child.visible = false;
            } else {
                child.visible = true; // explicitly turn it back on!
            }

            const lineOp = isBlueprint ? Math.min(1.0, wireOp * lWt * 1.5) : Math.min(1.0, wireOp * lWt);
            let baseOp = isWire ? lineOp : bOp;

            if (isIsolatedMode) {
                if (isHeroOn) {
                    baseOp *= Engine.uniforms.uIsolationAlpha.value;
                } else if (dist > focusRad) {
                    baseOp *= Engine.uniforms.uIsolationAlpha.value;
                }
            }

            child.material.opacity    = baseOp;
            // THE FIX: Explicitly turn off transparency when opaque to restore Early-Z culling
            child.material.transparent = baseOp < 1.0;
            child.material.depthWrite = !isWire;
            child.material.color.setHex(isWire ? Engine.currentTheme.ink : Engine.currentTheme.bFill);
            
            if (isWire && child.material.isLineMaterial) {
                child.material.linewidth = lWt * 1.5;
                child.material.resolution.copy(_rendSize);
                child.material.blending = isBlueprint ? THREE.AdditiveBlending : THREE.NormalBlending;
                if (isBlueprint) child.material.depthWrite = false;
            }
        }
    }

    Engine.groups.heroFill.visible = isHeroOn;
    Engine.groups.heroWire.visible = isHeroOn;

    for (const assetGroup of Engine.groups.heroFill.children) {
        if (!assetGroup.isGroup) continue;
        for (const mesh of assetGroup.children) {
            if (!mesh.isMesh) continue;
            mesh.material.opacity = bOp;
            mesh.material.color.setHex(Engine.currentTheme.bFill);
        }
    }
    for (const assetGroup of Engine.groups.heroWire.children) {
        if (!assetGroup.isGroup) continue;
        for (const mesh of assetGroup.children) {
            if (!isWireObject(mesh)) continue;
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.45 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = lWt * 1.5;
                mesh.material.resolution.copy(_rendSize);

                if (isBlueprint) {
                    mesh.material.blending = THREE.AdditiveBlending;
                    mesh.material.depthWrite = false;
                } else {
                    mesh.material.blending = THREE.NormalBlending;
                }
            }
        }
    }

    for (const mesh of Engine.groups.roads.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }
        
        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            const rKey = mesh.userData.colorKey ?? 'road';
            mesh.material.color.setHex(Engine.currentTheme[rKey] ?? Engine.currentTheme.road);
            mesh.material.opacity     = sOp;
            mesh.material.transparent = sOp < 1.0;
            mesh.material.depthWrite  = true;
        }
    }

    for (const mesh of Engine.groups.rails.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }
        
        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            mesh.material.color.setHex(Engine.currentTheme.rail);
            mesh.material.opacity     = sOp;
            mesh.material.transparent = sOp < 1.0;
            mesh.material.depthWrite  = true;
        }
    }

    for (const mesh of Engine.groups.ski.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }
        
        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            const key = mesh.userData.colorKey;
            mesh.material.color.setHex(Engine.currentTheme[key] ?? 0xffffff);
            mesh.material.opacity = sOp;
            mesh.material.transparent = sOp < 1.0;
            mesh.material.depthWrite = true;
        }
    }

    for (const mesh of Engine.groups.water.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }

        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            if (!mesh.isMesh) continue;
            mesh.material.color.setHex(Engine.currentTheme.water);
            mesh.material.opacity     = wOp;
            mesh.material.transparent = wOp < 1.0;
            mesh.material.depthWrite  = wOp >= 1.0;
        }
    }

    for (const mesh of Engine.groups.zones.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }

        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            if (!mesh.isMesh) continue;
            const zKey = mesh.userData.colorKey ?? 'institutional';
            mesh.material.color.setHex(Engine.currentTheme[zKey] ?? Engine.currentTheme.institutional);
            mesh.material.opacity     = 0.30;
            mesh.material.transparent = true;
            mesh.material.depthWrite  = false;
        }
    }

    for (const mesh of Engine.groups.veg.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }

        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            if (!mesh.isMesh) continue;
            const vKey = mesh.userData.colorKey ?? 'veg';
            mesh.material.color.setHex(Engine.currentTheme[vKey] ?? Engine.currentTheme.veg);
            mesh.material.opacity     = 1.0;
            mesh.material.transparent = false;
            mesh.material.depthWrite  = true;
        }
    }

    for (const mesh of Engine.groups.parks.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }

        if (isWire) {
            mesh.material.color.setHex(Engine.currentTheme.ink);
            mesh.material.opacity = Math.min(1.0, 0.3 * lWt);
            if (mesh.material.isLineMaterial) {
                mesh.material.linewidth = Math.max(1.0, lWt * 1.0);
                mesh.material.resolution.copy(_rendSize);
            }
        } else {
            if (!mesh.isMesh) continue;
            const pKey = mesh.userData.colorKey ?? 'park';
            mesh.material.color.setHex(Engine.currentTheme[pKey] ?? Engine.currentTheme.park);
            mesh.material.opacity     = 1.0;
            mesh.material.transparent = false;
            mesh.material.depthWrite  = true;
        }
    }

    for (const mesh of Engine.groups.micro.children) {
        mesh.visible = isInsidePlinth(mesh);
        if (!mesh.visible) continue;
        
        const isWire = isWireObject(mesh);
        if (isWire && killLines) {
            mesh.visible = false;
            continue;
        }

        if (mesh.material && mesh.material.vertexColors) {
            mesh.material.color.setHex(0xffffff); 
        } else {
            const mKey = mesh.userData.colorKey ?? 'road';
            mesh.material.color.setHex(Engine.currentTheme[mKey] ?? Engine.currentTheme.road);
        }

        mesh.material.opacity     = 1.0;
        mesh.material.transparent = false;
        mesh.material.depthWrite  = true;
    }

for (const mesh of Engine.groups.topo.children) {
        if (!mesh.isMesh && !mesh.isLineSegments) continue;
            mesh.renderOrder = -1; 
        if (mesh.material) {
            mesh.material.polygonOffset       = true;
            mesh.material.polygonOffsetFactor = 1; 
            mesh.material.polygonOffsetUnits  = 1;
            mesh.material.depthTest           = true;
        }
        if (mesh.isMesh) {
            mesh.material.color.setHex(Engine.currentTheme.topo);
            mesh.material.opacity     = 1.0;
            mesh.material.transparent = false;
            mesh.material.depthWrite  = true;
        }
    }

    if (!LightingState.csm) Engine.scene.background.set(Engine.currentTheme.bg);

    const gridEl = document.getElementById('grid-overlay');
    if (gridEl) gridEl.style.display = Engine.currentTheme.grid ? 'block' : 'none';

    const headerBox = document.getElementById('vitro-header');
    if (headerBox) {
        headerBox.style.backgroundColor = Engine.currentTheme.hdrBg;
        headerBox.style.color           = Engine.currentTheme.hdrText;
        headerBox.style.borderColor     = Engine.currentTheme.hdrText;
    }

    if (Engine.meta && Engine.geoCache.zData && Engine.currentThemeName !== _lastBakedTheme) {
        _lastBakedTheme = Engine.currentThemeName;
        const { zData, pData, vData, wData, skiData, hData } = Engine.geoCache;
        const r      = Engine.meta.radius || 1000;
        const newTex = bakeTerrainTexture(zData, pData, vData, wData, skiData, hData, r, Engine.currentTheme);
        for (const mesh of Engine.groups.topo.children) {
            if (!mesh.isMesh) continue;
            if (mesh.material.map) mesh.material.map.dispose();
            mesh.material.map         = newTex;
            mesh.material.needsUpdate = true;
        }
    }
}

// ============================================================================
// CAMERA & LAYOUT
// ============================================================================

export function centerCamera() {
    const radius = Engine.meta?.radius ?? 1000;
    const panY   = parseFloat(document.getElementById('sldPan-Y')?.value ?? '150');
    const isTop  = document.getElementById('btnTop')?.classList.contains('active')  ?? false;
    const isSide = document.getElementById('btnSide')?.classList.contains('active') ?? false;

    const cx = Engine.center?.x ?? 0;
    const cz = Engine.center?.z ?? 0;
    const target = new THREE.Vector3(cx, panY, cz);

    let dir;
    if (isTop)       dir = new THREE.Vector3(0, 1, 0.001).normalize();
    else if (isSide) dir = new THREE.Vector3(1, 0, 0).normalize();
    else             dir = new THREE.Vector3(1, 1, 1).normalize(); 

    const fov = 45;
    const idealDist = (radius * 1.5) / Math.tan(THREE.MathUtils.degToRad(fov / 2));

    if (Engine.camera.isOrthographicCamera) {
        Engine.camera.position.copy(target).addScaledVector(dir, radius * 4);
        Engine.camera.zoom = (radius * 4) / (radius * 3.5); 
    } else {
        Engine.camera.position.copy(target).addScaledVector(dir, idealDist);
    }

    Engine.controls.target.copy(target);
    Engine.camera.updateProjectionMatrix();
    Engine.controls.update();
}

export function updateLayout() {
    const dimsString = document.getElementById('paperSize')?.value ?? '12,12';
    const dims       = dimsString.split(',');
    const isPortrait = document.getElementById('btnPortrait')?.classList.contains('active') ?? true;

    const pW     = isPortrait ? parseFloat(dims[0]) : parseFloat(dims[1]);
    const pH     = isPortrait ? parseFloat(dims[1]) : parseFloat(dims[0]);
    const aspect = pW / pH;

    const canvasW = pW >= pH ? Engine.UI_MAX : Engine.UI_MAX * aspect;
    const canvasH = pW >= pH ? Engine.UI_MAX / aspect : Engine.UI_MAX;

    Engine.renderer.setSize(canvasW, canvasH);

    if (Engine.compositeCanvas) {
        Engine.compositeCanvas.width        = Engine.renderer.domElement.width;
        Engine.compositeCanvas.height       = Engine.renderer.domElement.height;
        Engine.compositeCanvas.style.width  = canvasW + 'px';
        Engine.compositeCanvas.style.height = canvasH + 'px';
    }

    const posterEl = document.getElementById('poster');
    if (posterEl) { posterEl.style.width = canvasW + 'px'; posterEl.style.height = canvasH + 'px'; }

    const f = (Engine.meta?.radius ?? 1000) * 4.0;
    Engine.camera.left   = (f * aspect) / -2;
    Engine.camera.right  = (f * aspect) /  2;
    Engine.camera.top    = f /  2;
    Engine.camera.bottom = f / -2;
    Engine.camera.updateProjectionMatrix();
}

// ============================================================================
// THEME
// ============================================================================

export function applyTheme(themeName) {
    Engine.currentThemeName = themeName in THEMES ? themeName : 'light';
    Engine.currentTheme = THEMES[Engine.currentThemeName];
    if (LightingState.csm) {
        setTimeOfDay(Engine.time.current);
    } else {
        Engine.scene.background.set(Engine.currentTheme.bg);
    }
    Engine.uniforms.uIsolationAlpha.value = Engine.currentTheme.isolationAlpha;
    updateStyles();
}

// ============================================================================
// SAVE / LOAD VIEW STATE
// ============================================================================

export function saveViewState() {
    const state = {
        camera: {
            position: Engine.camera.position.toArray(),
            zoom:     Engine.camera.zoom,
        },
        controls: {
            target: Engine.controls.target.toArray()
        },
        uniforms: {
            uPlinthRadius: Engine.uniforms.uPlinthRadius.value,
            uCenter:       [Engine.uniforms.uCenter.value.x, Engine.uniforms.uCenter.value.y],
            uIsolation:    Engine.uniforms.uIsolation.value
        },
        ui: {
            theme:      Engine.currentThemeName || 'light',
            lineWeight: document.getElementById('sldLine')?.value || '1.0'
        }
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
    const a = document.createElement('a');
    a.setAttribute("href",     dataStr);
    a.setAttribute("download", "vitro_save_state.json");
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export function loadViewState(jsonString) {
    try {
        const state = JSON.parse(jsonString);

        if (state.camera && state.controls) {
            Engine.camera.position.fromArray(state.camera.position);
            Engine.camera.zoom = state.camera.zoom;
            Engine.camera.updateProjectionMatrix();
            Engine.controls.target.fromArray(state.controls.target);
            Engine.controls.update();
        }

        if (state.uniforms) {
            Engine.uniforms.uPlinthRadius.value = state.uniforms.uPlinthRadius;
            Engine.uniforms.uCenter.value.set(state.uniforms.uCenter[0], state.uniforms.uCenter[1]);
            Engine.uniforms.uIsolation.value    = state.uniforms.uIsolation;
        }

        if (state.ui) {
            const sldPlinth = document.getElementById('sldPlinth');
            if (sldPlinth) sldPlinth.value = state.uniforms.uPlinthRadius;

            const sldLine = document.getElementById('sldLine');
            if (sldLine) {
                sldLine.value = state.ui.lineWeight;
                sldLine.dispatchEvent(new Event('input'));
            }

            const btnIsolate = document.getElementById('btnIsolate');
            if (btnIsolate) {
                if (state.uniforms.uIsolation > 0.5) btnIsolate.classList.add('active');
                else btnIsolate.classList.remove('active');
            }

            const themeButtonId = 'theme' + (state.ui.theme.charAt(0).toUpperCase() + state.ui.theme.slice(1));
            document.getElementById(themeButtonId)?.click();
        }

    } catch (e) {
        console.error("Failed to load save state:", e);
        alert("Invalid save state file.");
    }
}

export function setRadius(value) {
    Engine.uniforms.uPlinthRadius.value = value;
}

export function toggleHighResGround() {
    Engine.highResGround = !Engine.highResGround;
    _lastBakedTheme = null;
    updateStyles();
    return Engine.highResGround;
}

// ============================================================================
// FLY MODE
// ============================================================================

export function toggleFlyMode() {
    Engine.isFlyMode = !Engine.isFlyMode;
    if (Engine.isFlyMode) {
        Engine.controls.enabled = false;
        const euler = new THREE.Euler().setFromQuaternion(
            Engine.camera.quaternion, 'YXZ'
        );
        Engine.look.yaw   = euler.y;
        Engine.look.pitch = euler.x;
    } else {
        if (document.pointerLockElement) document.exitPointerLock();
        Engine.mouseLocked = false;
        Engine.controls.enabled = true;
        const dir = new THREE.Vector3();
        Engine.camera.getWorldDirection(dir);
        Engine.controls.target.copy(Engine.camera.position).addScaledVector(dir, 100);
        Engine.controls.update();
    }
}

function updateFlyPhysics() {
    if (!Engine.isFlyMode) return;

    const currentGround = getElevationAt(Engine.camera.position.x, Engine.camera.position.z);
    const relativeAlt   = Math.max(0, Engine.camera.position.y - currentGround);

    const speed = 0.5 + (relativeAlt * 0.015);

    const t = Math.max(0, Math.min(1, (relativeAlt - 50) / 2950));
    const targetFOV = 60 - (t * 15); 

    if (Math.abs(Engine.camera.fov - targetFOV) > 0.1) {
        Engine.camera.fov += (targetFOV - Engine.camera.fov) * 0.1; 
        Engine.camera.updateProjectionMatrix();
    }

    const moveVec = new THREE.Vector3();
    const forward = new THREE.Vector3();
    Engine.camera.getWorldDirection(forward);

    const right = new THREE.Vector3().crossVectors(forward, Engine.camera.up).normalize();

    forward.y = 0;
    forward.normalize();

    if (Engine.keyState['KeyW']) moveVec.add(forward);
    if (Engine.keyState['KeyS']) moveVec.add(forward.clone().negate());
    if (Engine.keyState['KeyA']) moveVec.add(right.clone().negate());
    if (Engine.keyState['KeyD']) moveVec.add(right);

    if (moveVec.length() > 0) Engine.camera.position.addScaledVector(moveVec.normalize(), speed);

    if (Engine.keyState['KeyE']) Engine.camera.position.y += speed;
    if (Engine.keyState['KeyQ']) Engine.camera.position.y -= speed;

    const minHeight = currentGround+12;
    if (Engine.camera.position.y < minHeight) Engine.camera.position.y = minHeight;
}

window.addEventListener('keydown', (e) => {
    const isGameActive = document.pointerLockElement !== null;
    const gameKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight'];

    if (isGameActive && gameKeys.includes(e.code)) {
        e.preventDefault();
    }
    Engine.keyState[e.code] = true;
});
window.addEventListener('keyup',   e => { Engine.keyState[e.code] = false; });

// ============================================================================

export function animate(timestamp) {
    requestAnimationFrame(animate);

    if (Engine.stats) Engine.stats.update();

    const dt = timestamp - (Engine.time.lastFrame || timestamp);
    Engine.time.lastFrame = timestamp;

    let timeChanged = false;
    if (Engine.time.mode === 'irl') {
        const newTime = getLocalSolarTime(Engine.meta?.lon || 0);
        if (Math.abs(Engine.time.current - newTime) > 0.01) {
            Engine.time.current = newTime;
            timeChanged = true;
        }
    } else if (Engine.time.mode === 'auto') {
        const speedFactor = (24 / 60000) * Engine.time.speed;
        Engine.time.current = (Engine.time.current + dt * speedFactor) % 24;
        timeChanged = true;
    }

    Engine.uniforms.uTime.value = timestamp * 0.001;

    if (Engine.matAviationLight) {
        const flash = Math.pow(Math.sin(timestamp * 0.002), 16);
        const isNight = Engine.time.current > 18.0 || Engine.time.current < 6.0;
        Engine.matAviationLight.opacity = isNight ? flash : 0.0;
    }

    if (Engine.matLampFlare) {
        const t = Engine.time.current;
        let targetOpacity = 0.0;

        if (t > 19.0 || t < 5.0) targetOpacity = 0.8;
        else if (t >= 18.0 && t <= 19.0) targetOpacity = (t - 18.0) * 0.8;
        else if (t >= 5.0 && t <= 6.0) targetOpacity = (1.0 - (t - 5.0)) * 0.8;

        Engine.matLampFlare.opacity = targetOpacity;
    }

    if (timeChanged) {
        setTimeOfDay(Engine.time.current);
        const sldTime = document.getElementById('sldTime');
        const timeLbl = document.getElementById('vTime');
        if (sldTime) sldTime.value = Engine.time.current;
        if (timeLbl) {
            const h = Math.floor(Engine.time.current);
            const m = Math.floor((Engine.time.current % 1) * 60).toString().padStart(2, '0');
            timeLbl.innerText = `${h}:${m}`;
        }
    }

    // Update telemetry display with throttling (10 Hz max)
    const now = performance.now();
    if (now - Engine.telemetry.lastUpdate >= Engine.telemetry.updateInterval) {
        Engine.telemetry.lastUpdate = now;
        
        // Get player state (imported PlayerState)
        if (PlayerState && PlayerState.telemetry) {
            const telemetry = PlayerState.telemetry;
            
            // Update DOM elements
            const speedEl = document.getElementById('telemetry-speed');
            const speedUnitEl = document.getElementById('telemetry-speed-unit');
            const elevationEl = document.getElementById('telemetry-elevation');
            const elevationUnitEl = document.getElementById('telemetry-elevation-unit');
            const headingEl = document.getElementById('telemetry-heading');
            const headingCardinalEl = document.getElementById('telemetry-heading-cardinal');
            const gForceEl = document.getElementById('telemetry-gforce');
            
            // Debug logging
            // if (!speedEl) console.warn('Telemetry: speed element not found');
            // if (!elevationEl) console.warn('Telemetry: elevation element not found');
            
            if (speedEl) speedEl.textContent = telemetry.currentSpeed.toFixed(1);
            if (speedUnitEl) speedUnitEl.textContent = telemetry.unitSystem === 'metric' ? 'KPH' : 'MPH';
            if (elevationEl) elevationEl.textContent = telemetry.currentElevation.toFixed(1);
            if (elevationUnitEl) elevationUnitEl.textContent = telemetry.unitSystem === 'metric' ? 'm' : 'ft';
            if (headingEl) {
                // Add 180 degrees to numeric heading to match cardinal direction fix
                let displayHeading = telemetry.currentHeading + 180;
                if (displayHeading >= 360) displayHeading -= 360;
                headingEl.textContent = Math.round(displayHeading).toString().padStart(3, '0') + '°';
            }
            if (headingCardinalEl) {
                // Get cardinal direction - shift by 180 degrees (4 positions) to fix north/south flip
                const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
                // Shift index by 4 (180 degrees) to flip north/south
                let index = Math.round(telemetry.currentHeading / 45) % 8;
                index = (index + 4) % 8; // Shift by 4 positions (180 degrees)
                headingCardinalEl.textContent = directions[index];
            }
            if (gForceEl) gForceEl.textContent = telemetry.currentGForce.toFixed(2);
            
            // Log first update for debugging
            if (Engine.telemetry._firstUpdate === undefined) {
                Engine.telemetry._firstUpdate = true;
                console.log('Telemetry system initialized, values:', {
                    speed: telemetry.currentSpeed,
                    elevation: telemetry.currentElevation,
                    heading: telemetry.currentHeading,
                    gForce: telemetry.currentGForce
                });
            }
        } else {
            console.warn('Telemetry: PlayerState or telemetry not available');
        }
    }

    if (Engine.isFlyMode) {
        updateFlyPhysics();
    } else if (PlayerState.isActive) {
        const physicsDt = Math.min(0.1, dt / 1000);
        updatePlayerPhysics(physicsDt, Engine, getElevationAt, getStructureAt, isInPortalHole);
    }

    if (Engine.controls && !Engine.isFlyMode && !PlayerState.isActive) Engine.controls.update();
    if (!Engine.renderer || !Engine.scene || !Engine.camera) return;

    Engine.camera.updateMatrixWorld();
    updateCSM();

    // ── Underground lighting state machine ───────────────────────────────
    // Drives a single `factor` (0 = surface, 1 = fully underground) that
    // suppresses sun + sky, darkens the background, and (once factor crosses
    // a hysteresis band) flips the discrete state. The emissive ceiling
    // strips inside tunnels use MeshBasicMaterial and remain fully lit.
    {
        const ug = Engine.underground;
        ug.targetFactor = PlayerState.isUnderground ? 1.0 : 0.0;

        // Frame-rate-independent exponential approach (~200 ms time constant).
        const dtSec = Math.min(0.1, dt / 1000);
        const k = 1.0 - Math.exp(-dtSec * 5.0);
        ug.factor += (ug.targetFactor - ug.factor) * k;
        if (ug.factor < 0.0005) ug.factor = 0.0;
        if (ug.factor > 0.9995) ug.factor = 1.0;

        // Hysteresis on the discrete state — useful for external queries.
        if (ug.state !== 'UNDERGROUND' && ug.factor > 0.95)      ug.state = 'UNDERGROUND';
        else if (ug.state !== 'SURFACE' && ug.factor < 0.05)     ug.state = 'SURFACE';
        else if (ug.factor > 0.05 && ug.factor < 0.95)           ug.state = 'TRANSITIONING';

        if (ug.factor > 0.0 && LightingState.csm) {
            const sunMul = 1.0 - ug.factor * 0.98;
            for (const light of LightingState.csm.lights) {
                light.intensity *= sunMul;
            }
            if (LightingState.skyLight) {
                // Keep a faint dim fill so tunnel walls aren't pitch-black.
                LightingState.skyLight.intensity =
                    LightingState.skyLight.intensity * (1.0 - ug.factor * 0.85) + ug.factor * 0.05;
            }
            if (Engine.scene.background && Engine.scene.background.isColor) {
                Engine.scene.background.lerp(_ugBgColor, ug.factor);
            }
        }
    }

    const zoom = Engine.camera.zoom;
    if (Engine._prevZoom === undefined || Math.abs(zoom - Engine._prevZoom) > 0.005) {
        Engine._prevZoom = zoom;
        updateStyles();
    }

    if (Engine.renderer.getContext().isContextLost()) return;

    Engine.renderer.render(Engine.scene, Engine.camera);

    // THE FIX: The massive CPU-bottleneck `drawImage` pixel copy is gone.
}

// ============================================================================
// EXPORT ENGINE
// ============================================================================

function bgIsLight(bgHex) {
    const r = (bgHex >> 16) & 0xff;
    const g = (bgHex >>  8) & 0xff;
    const b =  bgHex        & 0xff;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 127.5;
}

export function shutdown() {
    if (!Engine.renderer) return;
    Object.values(Engine.groups).forEach(g => g && disposeGroup(g));
    Engine.renderer.forceContextLoss();
    Engine.renderer.dispose();
    Engine.renderer.domElement = null;
}