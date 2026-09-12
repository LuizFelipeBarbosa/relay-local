package metrics

import (
	"runtime"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

type Snapshot struct {
	OS                string  `json:"os"`
	Arch              string  `json:"arch"`
	CPUs              int     `json:"cpus"`
	MemoryTotal       uint64  `json:"memory_total"`
	MemoryUsed        uint64  `json:"memory_used"`
	MemoryUsedPercent float64 `json:"memory_used_percent"`
	CPUPercent        float64 `json:"cpu_percent"`
	Uptime            uint64  `json:"uptime_seconds"`
}

func Read() Snapshot {
	result := Snapshot{OS: runtime.GOOS, Arch: runtime.GOARCH, CPUs: runtime.NumCPU()}
	if memory, err := mem.VirtualMemory(); err == nil {
		result.MemoryTotal = memory.Total
		result.MemoryUsed = memory.Used
		result.MemoryUsedPercent = memory.UsedPercent
	}
	if values, err := cpu.Percent(0, false); err == nil && len(values) > 0 {
		result.CPUPercent = values[0]
	}
	if value, err := host.Uptime(); err == nil {
		result.Uptime = value
	}
	return result
}
