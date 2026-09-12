import React, { useEffect, useState } from 'react';
import { DAYS, Schedule as Grid, alwaysOn, nightsAndWeekends, pad } from '../stats';
import { PageHead } from './shared';

const STORAGE_KEY = 'relay-schedule';

function loadSchedule(): Grid {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length === 7 && stored.every(row => Array.isArray(row) && row.length === 24)) return stored;
  } catch { /* fall through to the default */ }
  return nightsAndWeekends();
}

export function Schedule() {
  const [grid, setGrid] = useState<Grid>(loadSchedule);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(grid)); } catch { /* storage unavailable */ } }, [grid]);

  const hours = grid.flat().filter(Boolean).length;
  const toggle = (day: number, hour: number) => setGrid(current => current.map((row, d) => d === day ? row.map((on, h) => h === hour ? !on : on) : row));
  const preset = (make: () => Grid) => (e: React.MouseEvent) => { e.preventDefault(); setGrid(make()); };

  return <>
    <PageHead title="Schedule" note={`${hours} h / week accepting work · local time · saved in this browser; the agent does not enforce it yet`} />
    <section className="scroll">
      <div className="section-head">
        <h2>Weekly availability <span className="sub">click an hour to toggle</span></h2>
        <div className="links"><a href="#" onClick={preset(alwaysOn)}>Always on</a><a href="#" onClick={preset(nightsAndWeekends)}>Nights and weekends</a></div>
      </div>
      <div className="schedule">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span className="hour" key={h}>{h % 3 === 0 ? pad(h) : ''}</span>)}
        {grid.map((row, d) => <React.Fragment key={DAYS[d]}>
          <span className="day">{DAYS[d]}</span>
          {row.map((on, h) => <button key={h} className={on ? 'cell on' : 'cell'} title={`${DAYS[d]} ${pad(h)}:00 — ${on ? 'accepting' : 'paused'}`} onClick={() => toggle(d, h)} />)}
        </React.Fragment>)}
      </div>
      <div className="legend schedule-legend"><span><i className="box accent" />accepting</span><span><i className="box fill" />paused</span></div>
    </section>
  </>;
}
