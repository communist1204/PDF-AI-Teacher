import { useId } from 'react';
import type { z } from 'zod';
import type { DiagramSchema } from '../../../../../packages/shared/protocol';
export default function Diagram({block}:{block:z.infer<typeof DiagramSchema>}){
  const marker=useId().replace(/:/g,'');
  const positions=new Map(block.nodes.map((node,index)=>[node.id,{x:30+(index%2)*270,y:30+Math.floor(index/2)*130}]));
  const height=Math.ceil(block.nodes.length/2)*130+20;
  return <div className="diagram-block"><svg viewBox={`0 0 560 ${height}`} role="img" aria-label="教学计算图"><defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor"/></marker></defs>{block.edges.map((edge,index)=>{const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)return null;const down=b.y>a.y;return <g key={index}><line x1={a.x+100} y1={a.y+(down?55:28)} x2={b.x+(down?100:0)} y2={b.y+(down?0:28)} stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${marker})`}/>{edge.label&&<text x={(a.x+b.x)/2+100} y={(a.y+b.y)/2+20} textAnchor="middle" fontSize="11">{edge.label}</text>}</g>;})}{block.nodes.map(node=>{const p=positions.get(node.id)!;return <g key={node.id}><rect x={p.x} y={p.y} width="200" height="55" rx="9" fill="var(--diagram-fill,#f0f5eb)" stroke="currentColor"/><text x={p.x+100} y={p.y+32} textAnchor="middle" fontSize="13"><title>{node.label}</title>{node.label.length>16?node.label.slice(0,16)+'…':node.label}</text></g>;})}</svg><ul className="diagram-labels">{block.nodes.map(node=><li key={node.id}>{node.label}</li>)}</ul></div>;
}
