// ============================================================================
// LIGHTING SYSTEM — Vitro Omni-Engine
// Cascaded Shadow Maps (CSM), Time of Day illumination, atmospheric fog.
// ============================================================================
//
// ARCHITECTURE OVERVIEW
// ---------------------
// Three lighting components drive everything:
//
//   CSM (Cascaded Shadow Maps) — replaces the single DirectionalLight shadow
//                                 camera with 4 cascades that automatically
//                                 partition the view frustum for crisp shadows
//                                 at every distance.
//
//   skyLight  HemisphereLight   — sky dome + ground bounce. Provides soft,
//                                 directionless fill that prevents unlit faces
//                                 from going pitch-black.
//
//   FogExp2   on scene.fog      — exponential density fog whose color tracks
//                                 the sky, letting the city horizon dissolve
//                                 beautifully instead of hard-clipping.
//
// All three are driven by a single `timeOfDay` float (0 – 24).

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

// ============================================================================
// TIME-OF-DAY KEYFRAMES
// ============================================================================
//
// Each keyframe defines the lighting state at a specific hour.
// sampleTOD() bilinearly interpolates between the two surrounding keyframes.
//
// Colour notation: 0xRRGGBB hex integers.
//
// sunI   — CSM light intensity (sun is ~2.0 at solar noon, ~0.05 at night)
// sky    — HemisphereLight sky colour (top half of world)
// ground — HemisphereLight ground colour (bounce light from below)
// skyI   — HemisphereLight intensity
// fog    — FogExp2 colour
// bg     — Scene background colour (sky horizon approximation)

// Intensities tuned for ACES Filmic tone mapping at exposure 0.85.
const KF = [
    // t     sun        sunI   sky        ground     skyI    fog        bg
    { t:  0, sun:0x4060a0, sunI:0.15, sky:0x203060, ground:0x101830, skyI:0.35, fog:0x102040, bg:0x030710 }, // midnight
    { t:  5, sun:0x5070b0, sunI:0.20, sky:0x283870, ground:0x152040, skyI:0.40, fog:0x152850, bg:0x050b18 }, // pre-dawn
    { t:  6, sun:0xff7030, sunI:0.60, sky:0xff9060, ground:0xe06030, skyI:0.60, fog:0xffb078, bg:0xffb070 }, // dawn
    { t:  7, sun:0xffb060, sunI:1.20, sky:0xffc880, ground:0xe08840, skyI:0.75, fog:0xffd090, bg:0xffc880 }, // golden hour
    { t:  9, sun:0xfff0d0, sunI:1.80, sky:0xb0d0ff, ground:0x8090c0, skyI:0.90, fog:0xc8d8f0, bg:0xb8cce8 }, // morning
    { t: 12, sun:0xfffaf0, sunI:2.50, sky:0xa0c4ff, ground:0x607090, skyI:1.00, fog:0xb8cce4, bg:0xacc0e0 }, // solar noon
    { t: 15, sun:0xffecc0, sunI:2.00, sky:0x90b8f8, ground:0x587088, skyI:0.90, fog:0xb0c8e8, bg:0xa8bcd8 }, // afternoon
    { t: 17, sun:0xff9040, sunI:1.20, sky:0xff8050, ground:0xc04020, skyI:0.70, fog:0xff9060, bg:0xffa060 }, // late golden
    { t: 18, sun:0xff5020, sunI:0.60, sky:0xff4020, ground:0x901030, skyI:0.50, fog:0xd04030, bg:0xe04030 }, // dusk
    { t: 19, sun:0x504080, sunI:0.25, sky:0x302060, ground:0x181030, skyI:0.40, fog:0x201040, bg:0x180d38 }, // twilight
    { t: 21, sun:0x405090, sunI:0.15, sky:0x253060, ground:0x121830, skyI:0.35, fog:0x152040, bg:0x040810 }, // deep night
    { t: 24, sun:0x4060a0, sunI:0.15, sky:0x203060, ground:0x101830, skyI:0.35, fog:0x102040, bg:0x030710 }, // midnight (wrap)
];

// ============================================================================
// STATE
// ============================================================================

export const LightingState = {
    csm:         null,  // CSM instance
    skyLight:    null,  // THREE.HemisphereLight
    sceneRef:    null,  // THREE.Scene reference for fog + background updates

    timeOfDay: 12.0,
};

// ============================================================================
// INTERPOLATION
// ============================================================================

const _ca = new THREE.Color();
const _cb = new THREE.Color();

/** Linearly interpolate two 0xRRGGBB hex colours, return a THREE.Color. */
function lerpHex(hexA, hexB, t) {
    _ca.setHex(hexA);
    _cb.setHex(hexB);
    return _ca.clone().lerp(_cb, t);
}

/**
 * Sample all lighting parameters at a given time by interpolating keyframes.
 * @param {number} time  0 – 24
 * @returns {{ sunColor, sunI, skyColor, groundColor, skyI, fogColor, bgColor }}
 */
function sampleTOD(time) {
    const t = ((time % 24) + 24) % 24;

    let lo = KF[KF.length - 2];
    let hi = KF[KF.length - 1];
    for (let i = 0; i < KF.length - 1; i++) {
        if (t >= KF[i].t && t < KF[i + 1].t) { lo = KF[i]; hi = KF[i + 1]; break; }
    }

    const a = (t - lo.t) / (hi.t - lo.t);
    return {
        sunColor:    lerpHex(lo.sun,    hi.sun,    a),
        sunI:        lo.sunI    + (hi.sunI    - lo.sunI)    * a,
        skyColor:    lerpHex(lo.sky,    hi.sky,    a),
        groundColor: lerpHex(lo.ground, hi.ground, a),
        skyI:        lo.skyI    + (hi.skyI    - lo.skyI)    * a,
        fogColor:    lerpHex(lo.fog,    hi.fog,    a),
        bgColor:     lerpHex(lo.bg,     hi.bg,     a),
    };
}

// ============================================================================
// SUN POSITION MATH
// ============================================================================

const DEG = Math.PI / 180;

function sunDirection(timeOfDay) {
    const t     = ((timeOfDay % 24) + 24) % 24;
    const tN    = (t - 6) / 12;               // [0,1] during day
    const isDay = (tN >= 0 && tN <= 1);

    let az, el;
    if (isDay) {
        az = tN * Math.PI;
        el = Math.sin(tN * Math.PI) * 80 * DEG;
    } else {
        const tM = ((t - 18 + 24) % 24) / 12;
        az = Math.PI + tM * Math.PI;
        el = Math.sin(tM * Math.PI) * 38 * DEG;
    }

    return new THREE.Vector3(
        Math.cos(az) * Math.cos(el),
        Math.max(Math.sin(el), 0.12), // FIX: Raised from 0.02 to prevent extreme grazing angle shadow artifacts
        -Math.sin(az) * Math.cos(el) * 0.35,
    ).normalize();
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Call once, inside Engine.init(), after scene and renderer are created.
 *
 * @param {THREE.Scene}         scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ radius?: number }} meta
 * @param {THREE.Camera}        camera
 */
export function initLighting(scene, renderer, meta, camera) {
    const radius = meta?.radius ?? 1000;
    LightingState.sceneRef = scene;

    // ── Renderer shadow config ───────────────────────────────────────────────
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    // ── Cascaded Shadow Maps ─────────────────────────────────────────────────
    const csm = new CSM({
        maxFar:        meta.radius ? meta.radius * 3 : 3000,
        cascades:      4,

        // RESTORED FIX: Force custom distribution so high-res shadows stay near the camera
        mode:          'custom',
        customSplitsCallback: (cascades, near, far, breaks) => {
            breaks[0] = 0.02;
            breaks[1] = 0.08;
            breaks[2] = 0.25;
            breaks[3] = 1.0;
        },

        parent:        scene,
        shadowMapSize: 2048,
        lightDirection: new THREE.Vector3(-1, -1, -1).normalize(),
        camera:        camera,

        // NEW FIX: Prevent shadow clipping on massive buildings
        // lightMargin extends the shadow camera bounding box outward to catch tall objects.
        // lightFar extends the depth projection so shadows can stretch across the map.
        lightMargin:   500,
        lightFar:      10000,

        lightIntensity: 2.0,
    });

    // RESTORED FIX: Manually apply normalBias to eliminate terrain shadow acne
    for (const light of csm.lights) {
        light.shadow.bias = -0.0001;
        light.shadow.normalBias = 0.005;
    }

    csm.fade = true;
    LightingState.csm = csm;

    // ── HemisphereLight (Sky dome + ground bounce) ───────────────────────────
    const sky = new THREE.HemisphereLight(0xa0c4ff, 0x607090, 0.35);
    sky.name = 'vitro_sky';
    scene.add(sky);
    LightingState.skyLight = sky;

    // ── Atmospheric Fog (FogExp2) ────────────────────────────────────────────
    // const fogDensity = Math.max(0.00010, Math.min(0.00060, 0.5 / radius));
    // scene.fog = new THREE.FogExp2(0xb8cce4, fogDensity);

    // Apply noon lighting as the initial state
    setTimeOfDay(LightingState.timeOfDay);
}

// ============================================================================
// SET TIME OF DAY
// ============================================================================

/**
 * Update all lights and fog from a single time value.
 *
 * @param {number} time  0.0 – 24.0
 */
export function setTimeOfDay(time) {
    LightingState.timeOfDay = time;

    const { csm, skyLight, sceneRef } = LightingState;
    if (!csm || !skyLight) return;

    const tod    = sampleTOD(time);
    const sunDir = sunDirection(time);

    // ── CSM sun direction ────────────────────────────────────────────────────
    // CSM expects lightDirection as the direction the light travels (toward
    // the ground), so we negate the "toward the sun" vector.
    csm.lightDirection.copy(sunDir).negate();

    // Update CSM light color and intensity across all cascade lights
    for (const light of csm.lights) {
        light.color.copy(tod.sunColor);
        light.intensity = tod.sunI;
    }

    // ── Sky ──────────────────────────────────────────────────────────────────
    skyLight.color.copy(tod.skyColor);
    skyLight.groundColor.copy(tod.groundColor);
    skyLight.intensity = tod.skyI;

    // ── Fog ──────────────────────────────────────────────────────────────────
    if (sceneRef?.fog) {
        sceneRef.fog.color.copy(tod.fogColor);
    }

    // ── Scene background ─────────────────────────────────────────────────────
    if (sceneRef?.background?.isColor) {
        sceneRef.background.copy(tod.bgColor);
    }
}

// ============================================================================
// CSM UPDATE (call every frame from animate())
// ============================================================================

/**
 * Update the CSM cascade splits to track the camera.
 * Call this every frame after camera.updateMatrixWorld().
 */
export function updateCSM() {
    if (LightingState.csm) {
        LightingState.csm.update();
    }
}

// ============================================================================
// CSM MATERIAL REGISTRATION
// ============================================================================

/**
 * Register a material with CSM so it receives cascaded shadow chunks.
 * Must be called BEFORE chaining any custom onBeforeCompile overrides.
 * @param {THREE.Material} material
 */
export function registerCSMMaterial(material) {
    if (LightingState.csm) {
        LightingState.csm.setupMaterial(material);
    }
}
