#version 300 es
precision highp float;
layout(location=0) in vec2 aVertex;
layout(location=1) in vec4 aRect;
layout(location=2) in vec4 aQuaternion;
layout(location=3) in vec4 aInfo;
layout(location=4) in vec4 aShape;
layout(location=5) in vec4 aSurface;
layout(location=6) in float aDispersion;
uniform vec2 uViewport;
uniform float uPerspective;
uniform float uRadius;
uniform float uShift;
uniform mat3 uOrbit;
out vec2 vUv;
flat out vec2 vSize;
flat out float vImage;
flat out float vOpacity;
flat out float vHover;
flat out float vLens;
flat out float vDispersion;
flat out vec4 vShape;
flat out vec4 vSurface;
flat out mat3 vRotation;
out vec3 vWorld;
mat3 quatMatrix(vec4 q){
  vec3 a=q.xyz;float w=q.w;
  return mat3(1.-2.*(a.y*a.y+a.z*a.z),2.*(a.x*a.y+a.z*w),2.*(a.x*a.z-a.y*w),
  2.*(a.x*a.y-a.z*w),1.-2.*(a.x*a.x+a.z*a.z),2.*(a.y*a.z+a.x*w),
  2.*(a.x*a.z+a.y*w),2.*(a.y*a.z-a.x*w),1.-2.*(a.x*a.x+a.y*a.y));
}
void main(){
  vec2 local=aVertex*aRect.zw;
  float radius=aSurface.x>0.?aSurface.x:uRadius;
  float bulge=-dot(local,local)/(sqrt(max(radius*radius-dot(local,local),1.))+radius);
  mat3 model=quatMatrix(aQuaternion);
  vec3 world=uOrbit*(model*vec3(local,bulge)+vec3(aRect.xy,aInfo.x));
  world.z+=uShift;
  float depth=uPerspective-world.z;
  float near=max(1.,uPerspective*.05),far=30000.;
  gl_Position=vec4(world.x*uPerspective/uViewport.x*2.,-world.y*uPerspective/uViewport.y*2.,((far+near)/(far-near))*depth-2.*far*near/(far-near),depth);
  vWorld=world;vUv=aVertex+.5;vSize=aRect.zw;vImage=aInfo.y;vOpacity=aInfo.z;
  vHover=max(aInfo.w,0.);vLens=aInfo.w<0.?clamp(-aInfo.w-1.,0.,1.):1.;
  vDispersion=aDispersion;
  vRotation=uOrbit*model;vShape=aShape;vSurface=vec4(radius,aSurface.yzw);
}
