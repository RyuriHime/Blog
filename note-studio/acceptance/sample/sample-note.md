# 电磁感应实验记录

> 物理实验课 · 2026-10-02 · 法拉第电磁感应定律的验证

## 实验目的

验证感应电动势与磁通量变化率的关系：

$$
\varepsilon = -N \frac{\mathrm{d}\Phi}{\mathrm{d}t}
$$

其中行内符号 $N$ 为线圈匝数，$\Phi$ 为穿过线圈的磁通量。

## 装置与参数

| 器材 | 规格 | 备注 |
| --- | --- | --- |
| 线圈 | $N = 200$ 匝 | 截面积 $S = 4.0\ \mathrm{cm^2}$ |
| 磁铁 | 钕铁硼 | 表面磁感应强度约 $0.35\ \mathrm{T}$ |
| 采集卡 | 采样率 $10\ \mathrm{kHz}$ | 峰值保持模式 |

## 数据记录

1. 插入磁铁：$t = 0.20\ \mathrm{s}$，峰值电压 $1.84\ \mathrm{V}$
2. 抽出磁铁：$t = 0.18\ \mathrm{s}$，峰值电压 $1.92\ \mathrm{V}$

由峰值电压反推平均变化率：

$$
\left|\frac{\Delta\Phi}{\Delta t}\right| = \frac{U}{N} = \frac{1.84}{200} = 9.2 \times 10^{-3}\ \mathrm{Wb/s}
$$

## 结论

- [x] 感应电动势与磁通量变化率成正比
- [x] 方向由楞次定律决定（插入与抽出时极性相反）
- [ ] 补充不确定度分析（仪器精度 ±0.5%，重复测量 5 次）

## 数据处理脚本

```python
import numpy as np

voltage = np.loadtxt("coil.csv", delimiter=",")
peak = voltage.max()
flux_rate = peak / 200          # N = 200
print(f"峰值 {peak:.3f} V，平均变化率 {flux_rate:.3e} Wb/s")
```

## 参考

- 教材：《大学物理实验》第 4 章
- 数据与图：[实验原始记录](https://example.com/lab/emf-induction)

![实验装置示意图](images/setup.png "线圈与采集卡接线")
