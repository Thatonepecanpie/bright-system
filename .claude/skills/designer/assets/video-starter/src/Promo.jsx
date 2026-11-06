// Example composition: a shader background, a Flubber morph eased with Anime.js, and a headline.
// Everything is a pure function of the frame number, which is what makes Remotion renders deterministic.
import {useRef, useLayoutEffect} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {interpolate as morph} from 'flubber';
import {eases} from 'animejs';

// Shapes for the Flubber morph: a circle (64 points) and a 5-point star.
const circle = Array.from({length: 64}, (_, i) => {
  const a = (i / 64) * Math.PI * 2;
  return [640 + 120 * Math.cos(a), 330 + 120 * Math.sin(a)];
});
const star = Array.from({length: 10}, (_, i) => {
  const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
  const r = i % 2 ? 60 : 150;
  return [640 + r * Math.cos(a), 330 + r * Math.sin(a)];
});
const circleToStar = morph(circle, star, {maxSegmentLength: 4});
const outElastic = eases.outElastic(1, 0.45); // Anime.js v4 easing used as a pure function of time

// twigl-style fragment shader, drawn once per frame with the frame time as input.
const FRAG = `precision highp float;
uniform vec2 r; uniform float t;
void main(){
  vec2 p=(gl_FragCoord.xy*2.-r)/min(r.x,r.y);
  float d=length(p);
  vec3 c=mix(vec3(.035,.03,.04),vec3(.92,.38,.16),smoothstep(1.3,0.,d)*.5);
  c*=1.+.06*sin(d*9.-t*2.);  // slow, single-colour ripple: texture, not a rainbow
  gl_FragColor=vec4(c,1);
}`;

const ShaderBg = ({time}) => {
  const ref = useRef(null);
  const glRef = useRef(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!glRef.current) {
      const gl = canvas.getContext('webgl', {preserveDrawingBuffer: true});
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}'));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog); gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      glRef.current = {gl, prog};
    }
    const {gl, prog} = glRef.current;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'r'), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(prog, 't'), time);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [time]);
  return <canvas ref={ref} width={1280} height={720} style={{position: 'absolute', inset: 0}} />;
};

export const Promo = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = interpolate(frame, [10, 50], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const shape = circleToStar(outElastic(p));
  const rise = spring({frame: frame - 40, fps, config: {damping: 200}});
  return (
    <AbsoluteFill style={{fontFamily: 'sans-serif'}}>
      <ShaderBg time={frame / fps} />
      <svg width={1280} height={720} style={{position: 'absolute'}}>
        <path d={shape} fill="#f4efe6" />
      </svg>
      <div style={{position: 'absolute', bottom: 110, width: '100%', textAlign: 'center', color: '#f4efe6',
        fontSize: 64, fontWeight: 600, letterSpacing: -1.5, opacity: rise, transform: `translateY(${(1 - rise) * 30}px)`}}>
        One idea per screen.
      </div>
      <div style={{position: 'absolute', bottom: 70, width: '100%', textAlign: 'center', color: '#bdb3a6',
        fontFamily: 'monospace', fontSize: 18, letterSpacing: 2, opacity: rise}}>
        STARTER / REPLACE ME
      </div>
    </AbsoluteFill>
  );
};
