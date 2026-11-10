/**
 * Moteur de rendu : scène, caméra, lumière chaude, ciel, post-traitement (bloom + étalonnage).
 * Deux scènes : le monde, puis l'arme en vue FPS rendue par-dessus (profondeur remise à zéro).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { PALETTE } from '../config';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFlash: { value: 0 },
    uRewind: { value: 0 },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uTeal: { value: new THREE.Color(PALETTE.teal) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFlash, uRewind, uTime, uVignette;
    uniform vec3 uTeal;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // Rembobinage : lignes qui se décalent comme une bande magnétique + aberration chromatique.
      float band = floor(uv.y * 90.0);
      float jitter = (hash(band + floor(uTime * 40.0)) - 0.5) * 0.045 * uRewind;
      uv.x += jitter;
      float ca = 0.006 * uRewind;
      vec3 col = vec3(
        texture2D(tDiffuse, uv + vec2(ca, 0.0)).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - vec2(ca, 0.0)).b);
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, luma * uTeal * 1.6, uRewind * 0.55);
      // Légère chaleur + contraste doux.
      col = mix(vec3(luma), col, 1.08);
      col *= vec3(1.03, 1.0, 0.96);
      vec2 d = vUv - 0.5;
      col *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      col += vec3(1.0, 0.93, 0.78) * uFlash;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewScene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(78, 1, 0.08, 900);
  readonly viewCamera = new THREE.PerspectiveCamera(52, 1, 0.01, 10);
  readonly sun: THREE.DirectionalLight;
  readonly loader = new THREE.TextureLoader();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  flash = 0;
  rewind = 0;
  baseFov = 78;
  width = 1;
  height = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.info.autoReset = false;

    const scene = this.scene;
    scene.fog = new THREE.FogExp2(0xd9a07c, 0.0105);
    scene.background = new THREE.Color(0xe8c08e);

    // Lumière d'heure dorée : soleil bas et chaud, ciel crème, rebond prune.
    scene.add(new THREE.HemisphereLight(0xffe6bd, 0x6b3a55, 1.15));
    const sun = (this.sun = new THREE.DirectionalLight(0xffd29a, 2.6));
    sun.position.set(-38, 46, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 1; sc.far = 140;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 5;
    scene.add(sun, sun.target);

    // L'arme a sa propre lumière, cohérente avec le monde.
    this.viewScene.add(new THREE.HemisphereLight(0xffe6bd, 0x6b3a55, 1.3));
    const vl = new THREE.DirectionalLight(0xffd29a, 2.4);
    vl.position.set(-2, 3, 2);
    this.viewScene.add(vl);

    this.loadSky();

    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const composer = (this.composer = new EffectComposer(r, target));
    composer.addPass(new RenderPass(scene, this.camera));
    const viewPass = new RenderPass(this.viewScene, this.viewCamera);
    viewPass.clear = false;
    viewPass.clearDepth = true;
    composer.addPass(viewPass);
    // Seuil haut : seuls les matériaux HDR (cœurs de géodes, éclats, tirs) rayonnent.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.5, 0.5, 1.0);
    composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private loadSky(): void {
    const base = import.meta.env.BASE_URL;
    this.loader.load(`${base}assets/sky.webp`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(600, 48, 24),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
      );
      sky.renderOrder = -10;
      // Le panorama est un peu trop lumineux pour l'ACES : on le garde sous le seuil du bloom.
      (sky.material as THREE.MeshBasicMaterial).color.setScalar(0.86);
      sky.rotation.y = Math.PI * 0.5;
      this.scene.add(sky);
      this.scene.background = null;
    });
    this.loader.load(`${base}assets/sky_env.webp`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = tex;
      this.scene.environmentIntensity = 0.35;
      this.viewScene.environment = tex;
      this.viewScene.environmentIntensity = 0.6;
    });
  }

  texture(name: string, repeat = 1): THREE.Texture {
    const tex = this.loader.load(`${import.meta.env.BASE_URL}assets/${name}`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = 8;
    return tex;
  }

  resize(): void {
    const w = (this.width = window.innerWidth);
    const h = (this.height = window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = this.viewCamera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.updateProjectionMatrix();
  }

  render(time: number): void {
    const u = this.grade.uniforms;
    u.uFlash.value = this.flash;
    u.uRewind.value = this.rewind;
    u.uTime.value = time;
    this.composer.render();
  }

  /** Projette un point du monde en pixels écran. Retourne false s'il est derrière la caméra. */
  private v = new THREE.Vector3();
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = this.v.set(x, y, z).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    return v.z < 1 && v.z > -1;
  }
}
