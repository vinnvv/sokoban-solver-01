import fs from'fs';
const{MAKEFUN_INPUT_DIR:I,MAKEFUN_OUTPUT_DIR:O}=process.env;
for(let id of fs.readdirSync(I)){
let o=fs.readFileSync(I+'/'+id+'/level.txt','utf8'),H=o.indexOf('\n')+1,D=[-H,H,-1,1],p=o.search(/[@+]/),s=o.replace('@',' ').replace('+','.');
let e=(p/H)|0,k=i=>((i/H|0)>e)*2+(i%H>6),mv='',i;
while(s.includes('$')){
let K=k(s.indexOf('$')),Y=[];
for(i in s)if(k(i)==K&&'.*'.includes(s[i]))Y.push(i);
let Q=[[s,p,'']],V=new Set,f=0;
for(let h=0;h<Q.length&&!f;h++){
let[S,P,M]=Q[h],A=[],q=[P],l=P;A[P]='';
for(let x of q){if(x<l)l=x;for(let j=0;j<4;j++){let y=x+D[j];if(' .'.includes(S[y])&&A[y]==null){A[y]=A[x]+'udlr'[j];q.push(y)}}}
let w=S+l;if(V.has(w))continue;V.add(w);
for(let x of q){if(f)break;for(let j=0;j<4;j++){let y=x+D[j],u=y+D[j];
if(!'$*'.includes(S[y])||k(y)!=K||!' .'.includes(S[u]))continue;
let a=[...S];a[y]=' .'[S[y]=='*'|0];a[u]='$*'[S[u]=='.'|0];let T=a.join(''),N=M+A[x]+'UDLR'[j];
if(Y.every(z=>T[z]=='*')){mv+=N;p=y;s=T;f=1;break}
Q.push([T,y,N])}}
}
if(!f)break;
}
let d=O+'/'+id;fs.mkdirSync(d);fs.writeFileSync(d+'/solution.txt',mv);
}
