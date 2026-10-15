// Draws a frame that costs about what a real template would (a full-screen
// gradient, rings and 64 spectrum bars, all in one shader), encodes it, and
// passes the encoded stream on in batches.
(async () => {
  const { seconds, width, height, fps, accel } = await spike.config();
  const frames = Math.round(seconds * fps);
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { antialias: false });

  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
    in vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0, 1); }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; in vec2 uv; out vec4 color;
    uniform float t; uniform float bass; uniform float bands[64]; uniform vec2 size;
    void main() {
      vec2 p = (uv - 0.5) * vec2(size.x / size.y, 1.0);
      vec3 back = mix(vec3(0.05, 0.02, 0.12), vec3(0.0, 0.25, 0.3), uv.y + 0.2 * sin(t * 0.3 + uv.x * 3.0));
      float r = length(p);
      float rings = smoothstep(0.02, 0.0, abs(fract(r * 6.0 - t * 0.5) - 0.5) - 0.45) * (0.3 + bass);
      int i = int(clamp(uv.x * 64.0, 0.0, 63.0));
      float bar = step(uv.y, 0.08 + bands[i] * 0.3) * step(0.15, fract(uv.x * 64.0));
      color = vec4(back + rings * vec3(0.2, 0.9, 0.6) + bar * vec3(0.24, 0.86, 0.59), 1.0);
    }`));
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const u = (name) => gl.getUniformLocation(program, name);
  gl.uniform2f(u('size'), width, height);
  gl.viewport(0, 0, width, height);
  const bands = new Float32Array(64);

  const draw = (i) => {
    const t = i / fps;
    const bass = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 2.1)), 8);
    for (let b = 0; b < 64; b++) bands[b] = 0.5 + 0.5 * Math.sin(t * 3 + b * 0.4) * Math.exp(-b / 40);
    gl.uniform1f(u('t'), t);
    gl.uniform1f(u('bass'), bass);
    gl.uniform1fv(u('bands'), bands);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const config = {
    codec: 'avc1.640028', width, height, bitrate: 8_000_000, framerate: fps,
    hardwareAcceleration: accel, avc: { format: 'annexb' }, latencyMode: 'quality',
  };
  const support = await VideoEncoder.isConfigSupported(config);
  spike.log(`encoder ${accel}: ${support.supported ? 'supported' : 'NOT supported'}`);
  if (!support.supported) return spike.done({ supported: false });

  let pending = [];
  let pendingBytes = 0;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
    },
    error: (error) => (failure = String(error)),
  });
  encoder.configure(config);
  const send = async () => {
    if (pendingBytes === 0) return;
    const batch = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const bytes of pending) { batch.set(bytes, offset); offset += bytes.byteLength; }
    pending = [];
    pendingBytes = 0;
    await spike.chunk(batch);
  };

  const start = performance.now();
  let drawMs = 0;
  for (let i = 0; i < frames && !failure; i++) {
    const before = performance.now();
    draw(i);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    drawMs += performance.now() - before;
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
    if (pendingBytes > 1_000_000) await send();
    if (i > 0 && i % (fps * 60) === 0) {
      const elapsed = (performance.now() - start) / 1000;
      spike.log(`${i / fps / 60} min of video, ${(i / elapsed).toFixed(0)} fps, heap ${Math.round(performance.memory.usedJSHeapSize / 1e6)} MB`);
    }
  }
  await encoder.flush();
  await send();
  const elapsed = (performance.now() - start) / 1000;
  spike.done({
    supported: true, failure, frames, seconds: +elapsed.toFixed(1), fps: +(frames / elapsed).toFixed(1),
    drawMsPerFrame: +(drawMs / frames).toFixed(2), heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6),
  });
})().catch((error) => spike.log(`FAILED: ${error.stack ?? error}`));
