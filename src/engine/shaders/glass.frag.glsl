#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
flat in vec2 vSize;
flat in float vImage;
flat in float vOpacity;
flat in float vHover;
flat in float vLens;
flat in float vDispersion;
flat in vec4 vShape;
flat in vec4 vSurface;
flat in mat3 vRotation;
in vec3 vWorld;
uniform sampler2DArray uImages;
uniform sampler2D uEnvironment;
uniform sampler2D uFocusedImage;
uniform float uPerspective;
out vec4 outColor;
float sdf(vec2 p){float radius=vShape.x;vec2 q=abs(p)-vSize*.5+radius;return length(max(q,0.))+min(max(q.x,q.y),0.)-radius;}
float bevel(vec2 p){float d=sdf(p);float t=clamp(1.+d/vShape.y,0.,1.);return pow(max(1.-pow(t,3.9),0.),1./3.9)*vShape.z;}
vec2 cover(vec2 uv){float ratio=vSize.x/vSize.y;float imageRatio=vSurface.y;if(ratio<imageRatio)uv.x=(uv.x-.5)*ratio/imageRatio+.5;else uv.y=(uv.y-.5)*imageRatio/ratio+.5;return clamp(uv,vec2(.001),vec2(.999));}
vec3 imageAt(vec2 uv){uv=cover(uv);if(vImage<-.5)return pow(texture(uFocusedImage,uv).rgb,vec3(2.2));uv=(uv-.5)*vSurface.zw+.5;vec2 edge=.5*vSurface.zw,texel=.5/vec2(textureSize(uImages,0).xy);uv=clamp(uv,.5-edge+texel,.5+edge-texel);return pow(texture(uImages,vec3(uv,vImage)).rgb,vec3(2.2));}
vec3 environment(vec3 ray){float c=cos(-2.),s=sin(-2.);ray=vec3(ray.x*c-ray.z*s,ray.y,ray.x*s+ray.z*c);vec2 uv=vec2(atan(ray.z,ray.x)/(6.2831853)+.5,asin(clamp(ray.y,-1.,1.))/3.14159265+.5);vec4 rgbe=texture(uEnvironment,uv);return rgbe.rgb*exp2(rgbe.a*255.-128.)*(255./256.);}
void main(){
  vec2 p=(vUv-.5)*vSize;float d=sdf(p);float aa=max(fwidth(d)*.5,.3);float alpha=(1.-smoothstep(-aa,aa,d))*vOpacity;if(alpha<.01)discard;
  float epsilon=max(vShape.y*.06,.35);
  vec2 gradient=vec2(bevel(p+vec2(epsilon,0.))-bevel(p-vec2(epsilon,0.)),bevel(p+vec2(0.,epsilon))-bevel(p-vec2(0.,epsilon)))/(2.*epsilon);
  float slope=length(gradient);gradient*=min(slope,1.74)/max(slope,.0001);
  vec2 curve=p/sqrt(max(vSurface.x*vSurface.x-dot(p,p),1.));
  vec3 normal=normalize(vec3(curve-gradient,1.));
  vec3 view=normalize(transpose(vRotation)*(vec3(0.,0.,uPerspective)-vWorld));
  float thickness=vShape.z*vLens;
  vec3 red=refract(-view,normal,1./2.14),green=refract(-view,normal,1./2.3),blue=refract(-view,normal,1./2.46);
  red=mix(green,red,vDispersion);blue=mix(green,blue,vDispersion);
  vec2 ur=vUv+red.xy*(thickness/max(abs(red.z),.05))*.7/vSize;
  vec2 ug=vUv+green.xy*(thickness/max(abs(green.z),.05))*.7/vSize;
  vec2 ub=vUv+blue.xy*(thickness/max(abs(blue.z),.05))*.7/vSize;
  vec3 transmitted=vec3(imageAt(ur).r,imageAt(ug).g,imageAt(ub).b);
  vec3 worldNormal=normalize(vRotation*normal),worldView=normalize(vec3(0.,0.,uPerspective)-vWorld);
  vec3 reflection=environment(reflect(-worldView,worldNormal));
  float fresnel=.045+.955*pow(clamp(1.-dot(normal,view),0.,1.),5.);
  float rim=smoothstep(-vShape.w,0.,d)*.11*vLens;
  vec3 color=mix(transmitted,reflection,min(fresnel*1.93,.27)*vLens)+vec3(rim);
  color+=vec3(.009,.014,.017)*vHover*vLens;
  outColor=vec4(pow(max(color,vec3(0.)),vec3(1./2.2)),alpha);
}
