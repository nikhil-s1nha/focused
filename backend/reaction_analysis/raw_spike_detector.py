"""Reusable offline raw-step detector; no serial, UI, network, or hardware control.

A spike is a numeric abrupt change only. Quality remains unverified even when the
status word happens to match, because configuration and physiology are not verified.
"""
from __future__ import annotations
from dataclasses import dataclass
import json,math
from pathlib import Path

@dataclass(frozen=True)
class RawSpikeConfig:
    channel_scales: tuple[float,float]
    threshold: float
    threshold_name: str
    version: str='pooled-raw-step-v1'
    max_gap_seconds: float=.024
    def __post_init__(self):
        if len(self.channel_scales)!=2 or any(not math.isfinite(v) or v<=0 for v in self.channel_scales):raise ValueError('Need two positive finite training scales')
        if not math.isfinite(self.threshold) or self.threshold<0:raise ValueError('Need nonnegative finite threshold')


def config_from_report(path:Path,threshold_name:str):
    report=json.loads(Path(path).read_text())
    matches=[r for r in report['threshold_table'] if r['name']==threshold_name]
    if len(matches)!=1:raise ValueError('Choose an explicit threshold name from threshold_table')
    return RawSpikeConfig(tuple(report['scales_trained_only_on_earlier_recordings']),matches[0]['cutoff'],threshold_name)


class RawSpikeDetector:
    """Each update consumes an already captured frame, not a live hardware source.

    `spike` is null for initial, missing, reset, nonmonotonic, or late frames; false
    means a contiguous observed step was below threshold. Samples are not invented.
    Consecutive true samples may belong to one burst; this API does not label each
    crossing an independent event. The offline study separately groups crossings.
    """
    def __init__(self,config:RawSpikeConfig):self.config=config;self.previous=None
    def reset(self):self.previous=None
    def update(self,*,raw_hex:str,sequence:int,read_micros:int,segment:int=1):
        if len(raw_hex)!=18:raise ValueError('Expected exactly nine bytes encoded as eighteen hex characters')
        try:raw=bytes.fromhex(raw_hex)
        except ValueError as exc:raise ValueError('Invalid frame hex') from exc
        if len(raw)!=9:raise ValueError('Expected exactly nine raw bytes')
        if not isinstance(sequence,int) or not isinstance(read_micros,int):raise ValueError('Frame sequence and microsecond timestamp must be integers')
        status=int.from_bytes(raw[:3],'big');counts=(int.from_bytes(raw[3:6],'big',signed=True),int.from_bytes(raw[6:9],'big',signed=True))
        current={'segment':segment,'sequence':sequence,'read_micros':read_micros,'counts':counts}
        prior=self.previous;self.previous=current
        reason='first_frame';score=None;channel_scores=None;spike=None;gap=None
        if prior is not None:
            gap=(read_micros-prior['read_micros'])/1e6
            if segment!=prior['segment']:reason='new_segment'
            elif sequence!=prior['sequence']+1:reason='sequence_discontinuity'
            elif not 0<gap<=self.config.max_gap_seconds:reason='timestamp_gap_or_nonmonotonic'
            else:
                channel_scores=[abs(counts[i]-prior['counts'][i])/self.config.channel_scales[i] for i in range(2)]
                score=max(channel_scores);spike=score>self.config.threshold;reason='contiguous_raw_step'
        return {'version':self.config.version,'segment':segment,'sequence':sequence,'read_micros':read_micros,'raw_hex':raw_hex.upper(),'raw_counts':{'ch1':counts[0],'ch2':counts[1]},'spike':spike,'threshold_event':spike,'valid_measurement':False,'reaction_validated':False,'step_score':score,'channel_step_scores':channel_scores,'threshold':self.config.threshold,'threshold_name':self.config.threshold_name,'quality':'unverified','quality_flags':{'status_format_valid':(status&0xF01FFF)==0xC00000,'configuration_verified':False,'step_available':score is not None,'reason':reason,'elapsed_seconds':gap},'meaning':'raw_abrupt_change_only; not verified action, physiology, or emotion'}
