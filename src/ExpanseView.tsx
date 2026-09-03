import React, { useMemo, useState } from 'react';
import type { CampaignState, Passage, Sector } from './types';

const LEVEL_RADIUS = 130;
const NODE_RADIUS = 34;

interface LaidOutSector {
  sector: Sector;
  x: number;
  y: number;
  connected: boolean;
}

interface Edge {
  fromSectorId: string;
  toSectorId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Sectors have no fixed spatial coordinates in Starforged -- they're discovered, not placed on a
 * predetermined galactic grid -- so there's no "correct" position to reproduce, only a legible
 * one. Lays out connected sectors as a deterministic radial tree by graph distance (BFS) from the
 * first-created sector, since that's a stable, always-present anchor point every campaign has
 * (unlike "the current sector," which changes as the party travels). Each node's angular slice is
 * a subdivision of its own parent's slice (weighted by descendant count), not an even spread
 * across the full circle at its level regardless of parentage -- the latter, simpler approach was
 * tried first and rejected after actually tracing through a realistic, multi-branch scenario: it
 * can place a child on the opposite side of the circle from its real parent, with the connecting
 * line cutting straight through unrelated nodes. A real radial subdivision keeps every subtree
 * visually grouped together. Sectors with no linked passage to anything else are placed in a
 * clearly separate row below, rather than scattered in among connected ones where their lack of a
 * connection could be missed.
 */
function computeLayout(sectors: Record<string, Sector>): { nodes: LaidOutSector[]; edges: Edge[] } {
  const ids = Object.keys(sectors);
  if (ids.length === 0) return { nodes: [], edges: [] };

  const adjacency = new Map<string, Set<string>>();
  const edgeSet = new Map<string, Edge>();
  for (const id of ids) adjacency.set(id, new Set());
  for (const [sectorId, sector] of Object.entries(sectors)) {
    for (const p of sector.passages || []) {
      if (!p.toSectorId || !sectors[p.toSectorId]) continue;
      adjacency.get(sectorId)!.add(p.toSectorId);
      adjacency.get(p.toSectorId)!.add(sectorId);
      const key = [sectorId, p.toSectorId].sort().join('|');
      if (!edgeSet.has(key)) edgeSet.set(key, { fromSectorId: sectorId, toSectorId: p.toSectorId, x1: 0, y1: 0, x2: 0, y2: 0 });
    }
  }

  const rootId = ids.includes('sector-1') ? 'sector-1' : ids[0];

  // BFS to build a real tree (each node's parent and children, ignoring the extra edges that
  // exist in the underlying graph but would make it not a tree -- e.g. a passage back to a
  // grandparent) -- a radial subdivision needs an actual tree structure to subdivide, not a
  // general graph, and BFS parent pointers give exactly that even though edges (drawn separately,
  // below) still reflect every real connection, tree or not.
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const depth = new Map<string, number>();
  parent.set(rootId, null);
  depth.set(rootId, 0);
  children.set(rootId, []);
  const visited = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacency.get(id) || []) {
        if (!visited.has(n)) {
          visited.add(n);
          parent.set(n, id);
          depth.set(n, depth.get(id)! + 1);
          children.set(n, []);
          children.get(id)!.push(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }

  // Descendant count (including self) drives how much of the parent's angular slice each child
  // gets -- a branch with many nodes under it needs more room than a single leaf.
  const descendantCount = new Map<string, number>();
  const countDescendants = (id: string): number => {
    const kids = children.get(id) || [];
    const total = 1 + kids.reduce((sum, k) => sum + countDescendants(k), 0);
    descendantCount.set(id, total);
    return total;
  };
  countDescendants(rootId);

  const positions = new Map<string, { x: number; y: number }>();
  positions.set(rootId, { x: 0, y: 0 });
  const assignAngles = (id: string, angleStart: number, angleEnd: number) => {
    const kids = children.get(id) || [];
    if (kids.length === 0) return;
    const totalWeight = kids.reduce((sum, k) => sum + descendantCount.get(k)!, 0);
    let cursor = angleStart;
    for (const kid of kids) {
      const share = (descendantCount.get(kid)! / totalWeight) * (angleEnd - angleStart);
      const kidAngle = cursor + share / 2;
      const radius = depth.get(kid)! * LEVEL_RADIUS;
      positions.set(kid, { x: radius * Math.cos(kidAngle - Math.PI / 2), y: radius * Math.sin(kidAngle - Math.PI / 2) });
      assignAngles(kid, cursor, cursor + share);
      cursor += share;
    }
  };
  assignAngles(rootId, 0, 2 * Math.PI);

  const maxDepth = Math.max(...Array.from(visited).map((id) => depth.get(id)!));
  const unconnected = ids.filter((id) => !visited.has(id));
  const unconnectedRowY = (maxDepth + 1) * LEVEL_RADIUS + NODE_RADIUS;
  unconnected.forEach((id, i) => {
    positions.set(id, { x: (i - (unconnected.length - 1) / 2) * (NODE_RADIUS * 3), y: unconnectedRowY });
  });

  const nodes: LaidOutSector[] = ids.map((id) => ({
    sector: sectors[id],
    x: positions.get(id)!.x,
    y: positions.get(id)!.y,
    connected: visited.has(id),
  }));

  const edges: Edge[] = Array.from(edgeSet.values()).map((e) => ({
    ...e,
    x1: positions.get(e.fromSectorId)!.x,
    y1: positions.get(e.fromSectorId)!.y,
    x2: positions.get(e.toSectorId)!.x,
    y2: positions.get(e.toSectorId)!.y,
  }));

  return { nodes, edges };
}

export function ExpanseView({ state, campaignId, onStateChange }: { state: CampaignState; campaignId: string; onStateChange: (s: CampaignState) => void }) {
  const [linkingPassageId, setLinkingPassageId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => computeLayout(state.sectors), [state.sectors]);

  const bounds = useMemo(() => {
    if (nodes.length === 0) return { minX: -NODE_RADIUS, maxX: NODE_RADIUS, minY: -NODE_RADIUS, maxY: NODE_RADIUS };
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    return { minX: Math.min(...xs) - NODE_RADIUS - 30, maxX: Math.max(...xs) + NODE_RADIUS + 30, minY: Math.min(...ys) - NODE_RADIUS - 30, maxY: Math.max(...ys) + NODE_RADIUS + 40 };
  }, [nodes]);

  const switchTo = async (sectorId: string) => {
    if (sectorId === state.currentSectorId) return;
    const next = await window.game.switchSector({ campaignId, sectorId });
    onStateChange(next);
  };

  const linkPassage = async (fromSectorId: string, passageId: string, toSectorId: string) => {
    const next = await window.game.linkPassage({ campaignId, sectorId: fromSectorId, passageId, toSectorId: toSectorId || null });
    onStateChange(next);
    setLinkingPassageId(null);
  };

  // Every map-edge passage across every sector, in one place -- the natural "control center" for
  // cross-sector connectivity, matching the no-duplicate-home pattern used elsewhere (Truths, the
  // Codex, Combat): individual sector views still create/remove passages, but linking one to an
  // actual destination lives here, not scattered across however many sectors have one.
  const openPassages: { sectorId: string; sectorName: string; passage: Passage }[] = [];
  for (const [sectorId, sector] of Object.entries(state.sectors)) {
    for (const p of sector.passages || []) {
      if (p.toCell === null) openPassages.push({ sectorId, sectorName: sector.name || 'unnamed sector', passage: p });
    }
  }

  return (
    <div style={{ padding: '18px 28px', overflowY: 'auto', height: '100%' }}>
      <p className="panel-title" style={{ fontSize: 12 }}>
        Expanse — {Object.keys(state.sectors).length} sector{Object.keys(state.sectors).length === 1 ? '' : 's'} known
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 16, maxWidth: 640 }}>
        How the sectors you've discovered actually connect to each other, via charted passages that lead off the
        edge of a sector map. Sectors have no fixed position in the rules -- this lays them out by how they
        connect, not by any real coordinate. Click a sector to travel there.
      </p>

      <svg
        viewBox={`${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`}
        style={{ width: '100%', height: 360, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 20 }}
      >
        {edges.map((e, i) => (
          <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="var(--border)" strokeWidth={2} />
        ))}
        {nodes.map((n) => {
          const isCurrent = n.sector.id === state.currentSectorId;
          return (
            <g key={n.sector.id} transform={`translate(${n.x}, ${n.y})`} style={{ cursor: 'pointer' }} onClick={() => switchTo(n.sector.id)}>
              <circle
                r={NODE_RADIUS}
                fill={isCurrent ? 'var(--accent-copper)' : 'var(--bg-raised)'}
                stroke={n.connected ? 'var(--border)' : 'var(--danger)'}
                strokeWidth={n.connected ? 1 : 1.5}
                strokeDasharray={n.connected ? undefined : '4,3'}
              />
              <text textAnchor="middle" dy={4} fontSize={11} fontFamily="var(--font-mono)" fill={isCurrent ? 'var(--bg)' : 'var(--text)'} style={{ pointerEvents: 'none' }}>
                {(n.sector.name || 'unnamed').slice(0, 12)}
              </text>
              <text textAnchor="middle" dy={NODE_RADIUS + 14} fontSize={10} fontFamily="var(--font-mono)" fill="var(--text-dim)" style={{ pointerEvents: 'none' }}>
                {Object.keys(n.sector.cells).length} hex{Object.keys(n.sector.cells).length === 1 ? '' : 'es'}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="panel-title" style={{ fontSize: 12 }}>
        Open passages
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: -4, marginBottom: 10 }}>
        Charted routes leading off the edge of a sector map. Set by the GM automatically when a new sector is
        created specifically by traveling one of these -- link or correct any of them directly here.
      </p>
      {openPassages.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No open passages charted yet.</p>}
      {openPassages.map(({ sectorId, sectorName, passage }) => (
        <div className="track-card" key={passage.id} style={{ marginBottom: 6, padding: '8px 10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>{sectorName}</span> · from {passage.fromCell}
                {passage.notes && <span style={{ color: 'var(--text-dim)' }}> — {passage.notes}</span>}
              </div>
              <div style={{ fontSize: 12, color: passage.toSectorId ? 'var(--success)' : 'var(--text-dim)', marginTop: 2 }}>
                {passage.toSectorId ? `Linked to ${state.sectors[passage.toSectorId]?.name || passage.toSectorId}` : 'Not yet linked to a destination'}
              </div>
            </div>
            <button className="icon-btn" style={{ fontSize: 11, flexShrink: 0 }} onClick={() => setLinkingPassageId(linkingPassageId === passage.id ? null : passage.id)}>
              {passage.toSectorId ? 'Change' : 'Link'}
            </button>
          </div>
          {linkingPassageId === passage.id && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.values(state.sectors)
                .filter((s) => s.id !== sectorId)
                .map((s) => (
                  <button key={s.id} className="icon-btn" style={{ fontSize: 11 }} onClick={() => linkPassage(sectorId, passage.id, s.id)}>
                    {s.name || 'unnamed'}
                  </button>
                ))}
              {passage.toSectorId && (
                <button className="icon-btn" style={{ fontSize: 11, borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => linkPassage(sectorId, passage.id, '')}>
                  Clear link
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
