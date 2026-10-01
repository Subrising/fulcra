import { useMemo, useRef, useState, useLayoutEffect, useEffect, useCallback } from 'react';
import { PanSurface as HostPanSurface, type PanSurfaceProps } from "@getpaseo/plugin/client/react-native";
import { View, Text, Pressable, PanResponder } from 'react-native';
import { WorkButton } from './work-button';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import type { Fleet } from '../shared/fleet';
import { CARD, edgeSegments, graphOffset, workGraph, type GraphPage, type WorkNode } from './work-graph-layout';
import type { TrackerView } from '../shared/trackers';
import { openTrackerUrl } from './tracker-link';
function GraphViewport({ nativePan, onPanStart, onPanUpdate, onPanEnd, ...props }: PanSurfaceProps & { nativePan: boolean }) {
  return nativePan ? <HostPanSurface {...props} onPanStart={onPanStart} onPanUpdate={onPanUpdate} onPanEnd={onPanEnd}/> : <View {...props}/>;
}
export type GraphIntent = { zoom: number; x: number; y: number };
export function WorkGraph({ fleet, shown, selected, page, stale, frozen, onSelect, onTask, theme, intent, onIntentChange, compact = false, onTouchActive, nativePan = false, touchUnavailable = false, trackers }: { trackers?: TrackerView; nativePan?: boolean; touchUnavailable?: boolean; onTouchActive?: (active: boolean) => void; compact?: boolean; intent?: { current: GraphIntent | null }; onIntentChange?: (value: GraphIntent) => void; fleet: Fleet; shown: Fleet['nodes']; selected: string | null; page?: GraphPage; stale: boolean; frozen: boolean; onSelect: (id: string) => void; onTask: (id: string) => void } & Pick<PluginSurfaceProps, 'theme'>) {
  const c = theme.colors, layout = useMemo(() => workGraph(fleet, shown, selected, page, trackers), [fleet, shown, selected, page?.data, trackers]);
  const saved = intent?.current, finite = (n: number | undefined, fallback = 0) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : fallback;
  const [controlsOpen, showControls] = useState(false);
  const focused = !saved && compact ? layout.nodes.find(n => n.id === 'session:' + selected) : undefined;
  const [zoom, setZoom] = useState(Math.min(2, Math.max(0.5, finite(saved?.zoom, 1)))), [viewport, setViewport] = useState({ width: 320, height: 320 }), [requested, setRequested] = useState({ x: finite(saved?.x, focused ? Math.max(0, focused.x - 24) : 0), y: finite(saved?.y, focused ? Math.max(0, focused.y - 24) : 0) }), [inspected, inspect] = useState<string | null>(selected ? 'session:' + selected : null);
  const offset = graphOffset(requested.x, requested.y, layout.width, layout.height, viewport, zoom);
  // Temporary loading/resize bounds affect display only; never overwrite navigation intent.
  useLayoutEffect(() => { const next = { zoom, x: requested.x, y: requested.y }; if (intent) intent.current = next; onIntentChange?.(next); }, [intent, onIntentChange, zoom, requested.x, requested.y]);
  const current = useRef(offset), start = useRef(offset); current.current = offset;
  const bounded = (x: number, y: number) => graphOffset(x, y, layout.width, layout.height, viewport, zoom);
  const dragging = useRef(false), takeover = useRef({ x: 0, y: 0 });
  const finishTouch = useCallback(() => { dragging.current = false; takeover.current = { x: 0, y: 0 }; onTouchActive?.(false); }, [onTouchActive]);
  useEffect(() => finishTouch, [finishTouch]);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: e => { if (e.nativeEvent.touches.length === 1) takeover.current = { x: 0, y: 0 }; return false; },
    onStartShouldSetPanResponder: () => Boolean(onTouchActive),
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
    onMoveShouldSetPanResponderCapture: (_, g) => { const claim = Math.abs(g.dx) + Math.abs(g.dy) > 6; if (claim && !dragging.current) takeover.current = { x: g.dx, y: g.dy }; return claim; },
    // PanResponder zeros dx/dy at grant; retain the move that claimed a card gesture.
    onPanResponderGrant: () => { dragging.current = true; start.current = { x: current.current.x - takeover.current.x, y: current.current.y - takeover.current.y }; setRequested(graphOffset(start.current.x, start.current.y, layout.width, layout.height, viewport, zoom)); },
    onPanResponderMove: (_, g) => setRequested(graphOffset(start.current.x - g.dx, start.current.y - g.dy, layout.width, layout.height, viewport, zoom)),
    onPanResponderTerminationRequest: () => !dragging.current,
    onPanResponderRelease: finishTouch, onPanResponderTerminate: finishTouch,
  }), [layout.width, layout.height, viewport.width, viewport.height, zoom, finishTouch, onTouchActive]);
  const beginNativePan = () => { dragging.current = true; start.current = current.current; };
  const updateNativePan = ({ x, y }: { x: number; y: number }) => setRequested(graphOffset(start.current.x - x, start.current.y - y, layout.width, layout.height, viewport, zoom));
  const gestureProps = nativePan || touchUnavailable ? {} : {
    ...pan.panHandlers,
    onTouchStart: () => onTouchActive?.(true),
    onTouchEnd: (e: import('react-native').GestureResponderEvent) => { if (e.nativeEvent.touches.length === 0) finishTouch(); },
    onTouchCancel: finishTouch,
  };
  const focus = (n?: WorkNode) => setRequested(bounded(n ? n.x * zoom - 24 : 0, n ? n.y * zoom - 24 : 0));
  const action = (n: WorkNode) => { inspect(n.id); if (n.kind === 'task') onTask(n.target); if (n.kind === 'session') onSelect(n.target); };
  const detail = layout.nodes.find(n => n.id === inspected), byId = new Map(layout.nodes.map(n => [n.id, n]));
  const visible = layout.nodes.filter(n => n.x * zoom + CARD.width * zoom >= offset.x && n.x * zoom <= offset.x + viewport.width && n.y * zoom + CARD.height * zoom >= offset.y && n.y * zoom <= offset.y + viewport.height);
  const text = { color: c.foreground };
  return <View style={{ gap: 12, minHeight: 180 }}>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}><WorkButton theme={theme} label="Focus session" disabled={!selected} onPress={()=>focus(byId.get("session:"+selected))}/><WorkButton theme={theme} label="Map controls" expanded={controlsOpen} onPress={()=>showControls(!controlsOpen)}>{controlsOpen?"Map controls −":"Map controls +"}</WorkButton></View>
    {controlsOpen && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{[['Zoom out', () => setZoom(z => Math.max(0.5, z - 0.25))], ['Zoom in', () => setZoom(z => Math.min(2, z + 0.25))], ['Reset graph', () => { setZoom(1); setRequested({ x: 0, y: 0 }); }], ['Pan left', () => setRequested(bounded(offset.x - 220, offset.y))], ['Pan right', () => setRequested(bounded(offset.x + 220, offset.y))], ['Pan up', () => setRequested(bounded(offset.x, offset.y - 160))], ['Pan down', () => setRequested(bounded(offset.x, offset.y + 160))]].map(([label, fn]) => <WorkButton key={String(label)} theme={theme} label={String(label)} onPress={fn as () => void}/>)}</View>}
    <Text accessibilityLiveRegion="polite" style={{ color: c.foreground, fontWeight:"500" }}>{stale || page?.stale ? 'STALE · retained observations' : frozen ? 'Frozen observations' : 'Observed work'} · {shown.length} conversation{shown.length === 1 ? '' : 's'}{controlsOpen ? ` · ${Math.round(zoom * 100)}% · ${layout.nodes.length} nodes / ${layout.edges.length} links · ${Math.round(offset.x)}, ${Math.round(offset.y)}` : ''}</Text>
    {controlsOpen && <Text style={{ color: c.foregroundMuted }}>Task → session → observed activity → reported path. Dashed links: saved supervision; strong links: active supervision. Use the work list for full-size session labels and controls at every zoom level.</Text>}
    {page && <Text style={{ color: c.foregroundMuted }}>{page.historical ? 'Historical page' : 'Latest displayed page'}{page.loading ? ' · loading; retained page' : ''} · {page.data ? 'Current page only; full history and file changes unverified' : 'Waiting for activity observation'}</Text>}
    {touchUnavailable && <Text style={{ color: c.foregroundMuted }}>Update the Fulcra app to drag this map. Focus session and Map controls are available now.</Text>}
    <GraphViewport nativePan={nativePan} onPanStart={beginNativePan} onPanUpdate={updateNativePan} onPanEnd={finishTouch} testID="work-graph-viewport" accessibilityLabel={touchUnavailable ? 'Work graph; use navigation buttons' : 'Work graph; drag to pan or use navigation buttons'} onLayout={e => setViewport({ width: Math.max(1, e.nativeEvent.layout.width), height: Math.max(1, e.nativeEvent.layout.height) })} {...gestureProps}
      style={{ height: compact ? 340 : 520, minHeight: 120, overflow: 'hidden', borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface0 }}>
      {layout.edges.flatMap(edge => edgeSegments(byId.get(edge.from)!,byId.get(edge.to)!,edge.kind).map(([ax,ay,bx,by],index,segments)=>{const x1=ax*zoom-offset.x,y1=ay*zoom-offset.y,x2=bx*zoom-offset.x,y2=by*zoom-offset.y;
        if(Math.max(x1,x2)<0||Math.min(x1,x2)>viewport.width||Math.max(y1,y2)<0||Math.min(y1,y2)>viewport.height)return null;
        const width=Math.max(2,Math.hypot(x2-x1,y2-y1)),angle=Math.atan2(y2-y1,x2-x1),color=edge.kind==='supervision'?c.foreground:c.border;return <View key={edge.id+index} pointerEvents="none" accessible={false} style={{position:'absolute',left:0,top:0}}><View style={{position:'absolute',left:(x1+x2)/2-width/2,top:(y1+y2)/2,width,borderTopWidth:edge.kind==='supervision'&&edge.active?3:1,borderColor:color,borderStyle:edge.active?'solid':'dashed',transform:[{rotate:`${angle}rad`}]}}/>{index===segments.length-1&&<Text style={{position:'absolute',left:x2-8-Math.cos(angle)*7,top:y2-10-Math.sin(angle)*7,color,fontSize:18,transform:[{rotate:`${angle}rad`}]}}>›</Text>}</View>;}))}
      {visible.map(n => <Pressable key={n.id} accessibilityRole="button" accessibilityLabel={`${n.kind === 'session' ? 'Inspect' : n.kind} ${n.title}`} accessibilityState={{ selected: n.target === selected || n.id === inspected }} onPress={() => action(n)} style={{ position: 'absolute', left: n.x * zoom - offset.x, top: n.y * zoom - offset.y, width: CARD.width * zoom, height: Math.max(zoom < 0.75 ? 48 : 72, CARD.height * zoom), padding: 8 * zoom, gap: 3, borderWidth: n.target === selected ? 2 : 1, borderColor: n.target === selected ? c.accent ?? c.foreground : c.border, borderRadius: 14, backgroundColor: n.target === selected ? c.surface2 ?? c.surface0 : c.surface1 ?? c.surface0 }}><Text numberOfLines={2} style={{ ...text, fontSize: Math.max(12, 13 * zoom), fontWeight: '600' }}>{n.title}</Text>{zoom >= 0.75 && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: Math.max(11, 10 * zoom) }}>{n.kind} · {n.detail}</Text>}</Pressable>)}
    </GraphViewport>
    {detail && <Text selectable numberOfLines={3} style={text}>{detail.title} · {detail.detail}</Text>}
    {detail?.kind === 'tracker-issue' && detail.url && <WorkButton theme={theme} label="Open tracker item in browser" onPress={() => { openTrackerUrl(detail.url); }}>Open tracker item ↗</WorkButton>}
    {!shown.length && <Text style={text}>No enrolled sessions match these filters.</Text>}
  </View>;
}
