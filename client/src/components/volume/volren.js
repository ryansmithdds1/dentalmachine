// A small WebGL2 volume renderer for the CBCT viewer: the volume goes into one 3D texture and a
// full-screen shader marches a ray per pixel through it. Three looks:
//   mip  — maximum intensity projection (the brightest thing along each ray: a "3D x-ray")
//   dvr  — direct volume rendering: soft tissue faint, bone and teeth opaque ivory, lit from the eye
//   iso  — the surface where density crosses a threshold (teeth, bone), shaded like a solid
// No library: this is ~300 lines against ~1 MB for a general-purpose medical imaging toolkit.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vNdc;
out vec4 outColor;
uniform sampler3D uVol;
uniform mat4 uInv;       // clip space -> box space
uniform vec3 uBox;       // box size (largest side 1), centred on the origin
uniform vec3 uTexel;     // one voxel in texture coordinates
uniform float uLo;       // window, in the texture's 0..1 units
uniform float uHi;
uniform float uIso;
uniform float uOpacity;
uniform int uMode;       // 0 mip, 1 dvr, 2 iso
uniform int uSteps;
uniform int uInvert;

float vol(vec3 p) { return texture(uVol, p / uBox + 0.5).r; }
vec3 grad(vec3 p) {
  vec3 t = uTexel * uBox;
  return vec3(vol(p + vec3(t.x, 0, 0)) - vol(p - vec3(t.x, 0, 0)),
              vol(p + vec3(0, t.y, 0)) - vol(p - vec3(0, t.y, 0)),
              vol(p + vec3(0, 0, t.z)) - vol(p - vec3(0, 0, t.z)));
}
vec3 shade(vec3 base, vec3 n, vec3 view) {
  vec3 l = normalize(view + vec3(0.25, 0.1, 0.45));
  float diff = abs(dot(n, l));
  float spec = pow(max(dot(n, normalize(l + view)), 0.0), 32.0);
  return base * (0.28 + 0.78 * diff) + vec3(0.28) * spec;
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec4 a = uInv * vec4(vNdc, -1.0, 1.0);
  vec4 b = uInv * vec4(vNdc, 1.0, 1.0);
  vec3 ro = a.xyz / a.w;
  vec3 rd = normalize(b.xyz / b.w - ro);
  vec3 bg = mix(vec3(0.035, 0.045, 0.065), vec3(0.09, 0.11, 0.15), vNdc.y * 0.5 + 0.5);
  // Ray / box intersection.
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-0.5 * uBox - ro) * inv;
  vec3 t1 = (0.5 * uBox - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= tn) { outColor = vec4(bg, 1.0); return; }
  float dt = length(uBox) / float(uSteps);
  float t = tn + dt * hash(gl_FragCoord.xy); // jitter hides banding
  vec3 view = -rd;
  if (uMode == 0) {
    float m = 0.0;
    for (int n = 0; n < 2048; n++) {
      if (n >= uSteps || t > tf) break;
      m = max(m, vol(ro + rd * t));
      t += dt;
    }
    float g = clamp((m - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
    if (uInvert == 1) g = 1.0 - g;
    outColor = vec4(mix(bg, vec3(g), clamp(g * 4.0, 0.0, 1.0)), 1.0);
    return;
  }
  if (uMode == 2) {
    for (int n = 0; n < 2048; n++) {
      if (n >= uSteps || t > tf) break;
      float v = vol(ro + rd * t);
      if (v >= uIso) {
        // Refine the crossing between the last two samples.
        float lo = t - dt;
        float hi = t;
        for (int r = 0; r < 5; r++) { float mid = 0.5 * (lo + hi); if (vol(ro + rd * mid) >= uIso) hi = mid; else lo = mid; }
        vec3 p = ro + rd * hi;
        vec3 nrm = -normalize(grad(p) + 1e-6);
        float dens = clamp((vol(p + rd * dt * 2.0) - uIso) / max(1.0 - uIso, 1e-3) * 2.0, 0.0, 1.0);
        vec3 base = mix(vec3(0.93, 0.86, 0.74), vec3(1.0, 0.98, 0.93), dens);
        vec3 c = shade(base, nrm, view);
        float fog = clamp((hi - tn) / length(uBox), 0.0, 1.0);
        outColor = vec4(mix(c, c * 0.7, fog), 1.0);
        return;
      }
      t += dt;
    }
    outColor = vec4(bg, 1.0);
    return;
  }
  // Direct volume rendering, front to back.
  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  for (int n = 0; n < 2048; n++) {
    if (n >= uSteps || t > tf || alpha > 0.97) break;
    vec3 p = ro + rd * t;
    float v = vol(p);
    float x = clamp((v - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
    if (x > 0.02) {
      float op = x * x * uOpacity * dt * 60.0;
      op = clamp(op, 0.0, 1.0);
      vec3 base = mix(vec3(0.75, 0.38, 0.30), vec3(1.0, 0.96, 0.88), smoothstep(0.15, 0.7, x));
      vec3 g = grad(p);
      float gl = length(g);
      vec3 c = gl > 1e-4 ? shade(base, -g / gl, view) : base * 0.8;
      acc += (1.0 - alpha) * op * c;
      alpha += (1.0 - alpha) * op;
    }
    t += dt;
  }
  outColor = vec4(acc + (1.0 - alpha) * bg, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader failed');
  return s;
}

// ---- 4×4 matrices (column-major, as WebGL wants) ----
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up) {
  const z = norm(sub(eye, target));
  const x = norm(crossV(up, z));
  const y = crossV(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dotV(x, eye), -dotV(y, eye), -dotV(z, eye), 1];
}
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function invertMatrix(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  return inv.map((x) => x / (det || 1));
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dotV = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const DEFAULT_CAMERA = { yaw: 0, pitch: 0.12, dist: 1.75, panX: 0, panY: 0 };

// → { setVolume(vol), render(opts), dispose() } or null when the browser has no WebGL2.
export function createVolumeRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (name) => gl.getUniformLocation(prog, name);
  const U = Object.fromEntries(['uVol', 'uInv', 'uBox', 'uTexel', 'uLo', 'uHi', 'uIso', 'uOpacity', 'uMode', 'uSteps', 'uInvert'].map((n) => [n, u(n)]));
  let tex = null;
  let info = null;

  return {
    // The volume as 8-bit (0..255 over the scan's full range): plenty for a rendering, a quarter of the GPU
    // memory of floats, and always filterable. Halved when it's bigger than this GPU's 3D textures.
    setVolume(vol) {
      const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 256;
      let { nx, ny, nz } = vol;
      let step = 1;
      while (Math.max(nx, ny, nz) / step > maxSize) step *= 2;
      const tx = Math.floor(nx / step); const ty = Math.floor(ny / step); const tz = Math.floor(nz / step);
      const lo = vol.stats?.min ?? -1000;
      const hi = vol.stats?.max ?? 3000;
      const scale = 255 / Math.max(1, hi - lo);
      const u8 = new Uint8Array(tx * ty * tz);
      const src = vol.data;
      for (let k = 0, o = 0; k < tz; k++) {
        for (let j = 0; j < ty; j++) {
          const row = k * step * nx * ny + j * step * nx;
          for (let i = 0; i < tx; i++) u8[o++] = (src[row + i * step] - lo) * scale;
        }
      }
      if (tex) gl.deleteTexture(tex);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, tx, ty, tz, 0, gl.RED, gl.UNSIGNED_BYTE, u8);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
      const ext = [nx * vol.spacing[0], ny * vol.spacing[1], nz * vol.spacing[2]];
      const big = Math.max(...ext);
      // The texture's y (rows, toward the back) and z (slices, toward the head) run the same way as the
      // patient axes, so the box is the patient: x = left, y = back, z = up.
      info = { box: ext.map((e) => e / big), texel: [1 / tx, 1 / ty, 1 / tz], lo, hi, dims: [tx, ty, tz] };
    },
    // opts: { mode: 'mip'|'dvr'|'iso', window: {center, width}, iso (value), opacity, camera, quality (0..1), invert }
    render({ mode = 'mip', window: win, iso = 1000, opacity = 1, camera = DEFAULT_CAMERA, quality = 1, invert = false }) {
      if (!tex || !info) return;
      const w = canvas.width;
      const h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      const toUnit = (v) => (v - info.lo) / Math.max(1, info.hi - info.lo);
      const { yaw, pitch, dist, panX, panY } = camera;
      const eyeDir = [Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
      const right = norm(crossV(eyeDir.map((x) => -x), [0, 0, 1]));
      const up = crossV(right, eyeDir.map((x) => -x));
      const target = [right[0] * panX + up[0] * panY, right[1] * panX + up[1] * panY, right[2] * panX + up[2] * panY];
      const eye = [target[0] + eyeDir[0] * dist, target[1] + eyeDir[1] * dist, target[2] + eyeDir[2] * dist];
      const vp = multiply(perspective(0.55, w / h, 0.05, 20), lookAt(eye, target, Math.abs(pitch) > 1.5 ? [0, 1, 0] : [0, 0, 1]));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.uniform1i(U.uVol, 0);
      gl.uniformMatrix4fv(U.uInv, false, new Float32Array(invertMatrix(vp)));
      gl.uniform3fv(U.uBox, info.box);
      gl.uniform3fv(U.uTexel, info.texel);
      gl.uniform1f(U.uLo, toUnit(win.center - win.width / 2));
      gl.uniform1f(U.uHi, toUnit(win.center + win.width / 2));
      gl.uniform1f(U.uIso, toUnit(iso));
      gl.uniform1f(U.uOpacity, opacity);
      gl.uniform1i(U.uMode, mode === 'mip' ? 0 : mode === 'dvr' ? 1 : 2);
      gl.uniform1i(U.uInvert, invert ? 1 : 0);
      const steps = Math.min(2000, Math.round(Math.max(...info.dims) * 1.7 * Math.max(0.25, quality)));
      gl.uniform1i(U.uSteps, Math.max(64, steps));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      if (tex) gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
