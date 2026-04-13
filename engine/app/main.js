// ============================================================================
// MAIN — Vitro Omni-Engine Entry Point
// ============================================================================

import * as THREE from 'three';
import * as Core from './engine-core.js';
import { PlayerState, updatePlayerPhysics } from './player.js';

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
    try {
        const response = await fetch('./metadata.json?v=' + Date.now());
        const meta     = await response.json();

        const elTitle = document.getElementById('h-title');
        const elSub   = document.getElementById('h-sub');
        const elGps   = document.getElementById('h-gps');
        if (elTitle) elTitle.innerText = (meta.city   || 'CITY').toUpperCase();
        if (elSub)   elSub.innerText   = (meta.region || 'REGION').toUpperCase();
        if (elGps)   elGps.innerText   = `${(meta.lat || 0).toFixed(4)}° N / ${Math.abs(meta.lon || 0).toFixed(4)}° W`;

        const container = document.getElementById('three-canvas');
        Core.init(container, meta);

        await Core.loadAllLayers();
        // Auto-load hero_model.glb if it exists, skip silently if not
        const heroProbe = await fetch('./hero_model.glb', { method: 'HEAD' });
        if (heroProbe.ok) Core.loadInitialHeroAsset();
        Core.centerCamera();
        Core.updateStyles();

        setupEventListeners();

        // Default to Fly Mode
        Core.toggleFlyMode();
        const flyBtn = document.getElementById('btnFlyMode');
        if (flyBtn) {
            flyBtn.classList.add('active');
            flyBtn.textContent = 'Fly Mode: ON  [WASD / QE]';
        }

    } catch (err) {
        console.error('Vitro Core Initialization Error:', err);
    }
}

// ============================================================================
// UI EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
    // --- Sliders ---
    document.querySelectorAll('input[type=range]').forEach(input => {
        input.addEventListener('input', e => {
            const id  = e.target.id;
            const val = parseFloat(e.target.value);

            const lbl = document.getElementById(id.replace('sld', 'v'));
            if (lbl) lbl.innerText = val;

            const ast = Core.Engine.loadedAssets[Core.Engine.activeAssetId];

            if      (id === 'sldHero-H'   && ast) { ast.h   = val; Core.applyAssetTransforms(Core.Engine.activeAssetId); }
            else if (id === 'sldHero-Rot' && ast) { ast.rot = val; Core.applyAssetTransforms(Core.Engine.activeAssetId); }
            else if (id === 'sldHero-Y'   && ast) { ast.y   = val; Core.applyAssetTransforms(Core.Engine.activeAssetId); }
            else if (id === 'sldHero-X'   && ast) { ast.x   = val; Core.applyAssetTransforms(Core.Engine.activeAssetId); }
            else if (id === 'sldHero-Z'   && ast) { ast.z   = val; Core.applyAssetTransforms(Core.Engine.activeAssetId); }
            else if (id === 'sldHero-Clip')        { Core.Engine.heroClipPlane.constant = -val; }
            else if (id === 'sldPan-Y')            { Core.centerCamera(); }
            else if (id === 'sldSpin')             { Core.Engine.controls.autoRotateSpeed = val; }
            else if (id === 'sldPlinth')           { Core.setRadius(val); }
            else if (id === 'sldVegDensity') {
                const mesh = Core.Engine.treeMesh;
                if (mesh) mesh.count = Math.min(Math.round(val), Core.Engine.treeMeshTotal);
                Core.Engine.treeDensity = Math.round(val);
            }
            else                                   { Core.updateStyles(); }
        });
    });

    // --- Hero Engine Toggle ---
    document.getElementById('btnToggleEngine')?.addEventListener('click', function() {
        this.classList.toggle('active');
        if (this.classList.contains('active')) {
            this.innerText = 'HERO ENGINE: ON';
            this.style.backgroundColor = 'var(--accent)';
            this.style.color = '#000000';
        } else {
            this.innerText = 'HERO ENGINE: OFF (PURE MAP)';
            this.style.backgroundColor = 'transparent';
            this.style.color = 'var(--text)';
        }
        Core.updateStyles();
    });

    // --- Camera Geometry --- //
    document.getElementById('togCameraPerspective')?.addEventListener('click', function() {
        this.classList.toggle('active');
        if (this.classList.contains('active')) {
            this.innerText = 'CAMERA GEOMETRY: ORTHOGRAPHIC';
            this.style.backgroundColor = 'transparent';
            this.style.color = 'var(--text)';
        } else {
            this.innerText = 'CAMERA GEOMETRY: PERSPECTIVE';
            this.style.backgroundColor = 'transparent';
            this.style.color = 'var(--text)';
        }
        Core.toggleCamera();
    });

    // --- Auto Spin ---
    document.getElementById('btnAutoSpin')?.addEventListener('click', function() {
        this.classList.toggle('active');
        Core.Engine.controls.autoRotate = this.classList.contains('active');
    });

    // --- Fly Mode ---
    document.getElementById('btnFlyMode')?.addEventListener('click', function() {
        Core.toggleFlyMode();
        const on = Core.Engine.isFlyMode;
        this.classList.toggle('active', on);
        this.textContent = on ? 'Fly Mode: ON  [WASD / QE ]' : 'Fly Mode: OFF';
    });

    // --- Layer Toggles ---
    function setupToggle(btnId, groupKeys) {
        document.getElementById(btnId)?.addEventListener('click', function() {
            this.classList.toggle('active');
            const isVisible = this.classList.contains('active');
            if (btnId === 'togHero') {
                Core.updateStyles();
            } else {
                groupKeys.forEach(key => { Core.Engine.groups[key].visible = isVisible; });
            }
        });
    }

    setupToggle('togTopo',  ['topo']);
    setupToggle('togB',     ['bFill', 'bWire']);
    setupToggle('togHero',  []);
    setupToggle('togTopo',  ['topo']);
    setupToggle('togRoof',  ['roofs']);
    setupToggle('togWin',   ['detail']);
    setupToggle('togRoad',  ['roads']);
    setupToggle('togRail',  ['rails']);
    setupToggle('togPark',  ['parks']);
    setupToggle('togVeg',   ['veg']);
    setupToggle('togWater', ['water']);
    setupToggle('togZone',  ['zones']);
    setupToggle('togMicro', ['micro']);

    document.getElementById('togHeader')?.addEventListener('click', function() {
        this.classList.toggle('active');
        const hBox = document.getElementById('vitro-header');
        if (hBox) hBox.style.opacity = this.classList.contains('active') ? '1' : '0';
    });

    // --- Themes ---
    const themeMap = {
        themeLight:     'light',
        themeGraphite:  'graphite',
        themeBlueprint: 'blueprint',
        themeOnyx:      'onyx',
        themeAmber:     'amber',
        themeSlate:     'slate',
    };
    Object.entries(themeMap).forEach(([btnId, themeName]) => {
        document.getElementById(btnId)?.addEventListener('click', function() {
            document.querySelectorAll('button[id^="theme"]').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            Core.applyTheme(themeName);
        });
    });

    // --- Orientation ---
    const btnPortrait  = document.getElementById('btnPortrait');
    const btnLandscape = document.getElementById('btnLandscape');
    btnPortrait?.addEventListener('click',  function() { this.classList.add('active'); btnLandscape?.classList.remove('active'); Core.updateLayout(); });
    btnLandscape?.addEventListener('click', function() { this.classList.add('active'); btnPortrait?.classList.remove('active');  Core.updateLayout(); });
    document.getElementById('paperSize')?.addEventListener('change', () => Core.updateLayout());

    // --- View Modes ---
    const btnIso  = document.getElementById('btnIso');
    const btnTop  = document.getElementById('btnTop');
    const btnSide = document.getElementById('btnSide');

    btnIso?.addEventListener('click',  function() {
        this.classList.add('active'); btnTop?.classList.remove('active'); btnSide?.classList.remove('active');
        Core.Engine.controls.enableRotate = true;
        Core.Engine.controls.enablePan    = false;
        Core.Engine.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        Core.centerCamera(); Core.updateStyles();
    });
    btnTop?.addEventListener('click',  function() {
        this.classList.add('active'); btnIso?.classList.remove('active'); btnSide?.classList.remove('active');
        Core.Engine.controls.enableRotate = false;
        Core.Engine.controls.enablePan    = true;
        Core.Engine.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        Core.centerCamera(); Core.updateStyles();
    });
    btnSide?.addEventListener('click', function() {
        this.classList.add('active'); btnIso?.classList.remove('active'); btnTop?.classList.remove('active');
        Core.Engine.controls.enableRotate = true;
        Core.Engine.controls.enablePan    = false;
        Core.Engine.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        Core.centerCamera(); Core.updateStyles();
    });

    // --- Isolation ---
    document.getElementById('btnIsolate')?.addEventListener('click', function() {
        this.classList.toggle('active');
        Core.updateStyles();
    });

    // --- Asset Select ---
    document.getElementById('asset-select')?.addEventListener('change', function() {
        Core.Engine.activeAssetId = this.value;
        const ast = Core.Engine.loadedAssets[Core.Engine.activeAssetId];
        if (!ast) return;

        [
            ['sldHero-H',   ast.h],
            ['sldHero-Rot', ast.rot],
            ['sldHero-Y',   ast.y],
            ['sldHero-X',   ast.x],
            ['sldHero-Z',   ast.z],
        ].forEach(([id, val]) => {
            const el  = document.getElementById(id);
            const lbl = document.getElementById(id.replace('sld', 'v'));
            if (el)  el.value      = val;
            if (lbl) lbl.innerText = val;
        });
    });

    // --- GLB Upload ---
    document.getElementById('asset-upload')?.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = event => Core.loadGLBFromBuffer(event.target.result, file.name);
        reader.readAsArrayBuffer(file);
    });

    // --- Export ---
    document.getElementById('export-btn-master')?.addEventListener('click', () => Core.exportImage());

    // --- Save / Load View State ---
    document.getElementById('btnSaveState')?.addEventListener('click', () => Core.saveViewState());

    document.getElementById('btnLoadState')?.addEventListener('click', () => {
        document.getElementById('stateFileInput')?.click();
    });

    document.getElementById('stateFileInput')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => Core.loadViewState(ev.target.result);
        reader.readAsText(file);
        e.target.value = ''; // reset so the same file can be re-loaded
    });

    // --- Video Sequence Controls ---
    const sldDur = document.getElementById('sldSeqDuration');
    const sldFps = document.getElementById('sldSeqFPS');
    const lblTotal = document.getElementById('vSeqTotalFrames');

    function updateTotalFrames() {
        const dur = parseInt(sldDur?.value || '10');
        const fps = parseInt(sldFps?.value || '30');
        if (lblTotal) lblTotal.innerText = dur * fps;
    }

    sldDur?.addEventListener('input', e => {
        const lbl = document.getElementById('vSeqDuration');
        if (lbl) lbl.innerText = e.target.value;
        updateTotalFrames();
    });
    sldFps?.addEventListener('input', e => {
        const lbl = document.getElementById('vSeqFPS');
        if (lbl) lbl.innerText = e.target.value;
        updateTotalFrames();
    });

    document.getElementById('btnExportVideo')?.addEventListener('click', () => {
        const dur = parseInt(sldDur?.value || '10');
        const fps = parseInt(sldFps?.value || '30');
        const res = (document.getElementById('selSeqResolution')?.value || '1920,1080').split(',').map(Number);
        const ssaa = parseInt(document.getElementById('selSeqSSAA')?.value || '2');
        Core.exportTurntableSequence(dur, fps, res[0], res[1], ssaa);
    });

    // --- 16K Ground Texture Toggle ---
    const btnHighRes = document.getElementById('togHighResGround');
    if (btnHighRes) {
        btnHighRes.addEventListener('click', () => {
            const isActive = Core.toggleHighResGround();
            if (isActive) {
                btnHighRes.classList.add('active');
                btnHighRes.innerText = '32K GROUND TEXTURE: ON';
            } else {
                btnHighRes.classList.remove('active');
                btnHighRes.innerText = '32K GROUND TEXTURE: OFF';
            }
        });
    }

    // --- Shutdown ---
    window.addEventListener('beforeunload', () => Core.shutdown());

    // --- Spacebar Auto-Rotate Toggle ---
    // window.addEventListener('keydown', (e) => {
    //     // Trigger only on Spacebar, and ensure we aren't typing inside a text input
    //     if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    //         e.preventDefault(); // Prevent the browser from scrolling down
    //         const btnSpin = document.getElementById('btnAutoSpin');
    //         if (btnSpin) {
    //             btnSpin.click(); // Reuses your existing toggle logic perfectly
    //         }
    //     }
    // });
}

start();
