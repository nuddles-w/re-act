#!/usr/bin/env python3
"""
腾讯网格交易策略回测 - 修正版
策略：
1. 初始 100 万全仓买入腾讯
2. 低于 500 港币，每下跌 10% 加仓 1 手（100 股）
3. 涨到 580 港币开始，每上涨 10 港币减仓 1 手（100 股）
"""

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

INITIAL_CAPITAL = 1_000_000  # 初始资金 100 万人民币
SHARES_PER_TRADE = 100       # 每次交易 1 手 = 100 股

# 买入网格：低于 500 HKD，每跌 10% 买入
BUY_TRIGGER = 500
BUY_INTERVAL_PCT = 0.10

# 卖出网格：高于 580 HKD，每涨 10 HKD 卖出
SELL_TRIGGER = 580
SELL_INTERVAL = 10

print("正在获取腾讯控股港股数据 (0700.HK)...")
end_date = datetime.now()
start_date = end_date - timedelta(days=3*365)

# 获取腾讯港股数据
tencent = yf.download('0700.HK', start=start_date, end=end_date, progress=False)

if tencent.empty:
    print("❌ 无法获取腾讯港股数据")
    exit(1)

print(f"✓ 获取到 {len(tencent)} 天的数据 ({tencent.index[0].date()} ~ {tencent.index[-1].date()})")

# 初始化：全仓买入
initial_price = float(tencent['Close'].iloc[0])
shares = INITIAL_CAPITAL / initial_price
cash = 0  # 全仓买入，现金为 0
trades = []

# 记录已触发的买入/卖出价位
buy_levels_triggered = set()
sell_levels_triggered = set()

print(f"\n初始状态：")
print(f"  初始价格: HK${initial_price:.2f}")
print(f"  初始买入: {shares:.2f} 股 (¥{INITIAL_CAPITAL:,.0f})")
print(f"  买入触发: < HK${BUY_TRIGGER} (每跌 10% 加仓 100 股)")
print(f"  卖出触发: > HK${SELL_TRIGGER} (每涨 HK$10 减仓 100 股)")
print(f"\n开始回测...\n")

# 回测循环
for date, row in tencent.iterrows():
    price_hkd = float(row['Close'])

    # 买入逻辑：低于 500，每跌 10% 加仓 1 手
    if price_hkd < BUY_TRIGGER:
        drop_from_trigger = (BUY_TRIGGER - price_hkd) / BUY_TRIGGER
        level_index = int(drop_from_trigger / BUY_INTERVAL_PCT)
        buy_price_level = BUY_TRIGGER * (1 - level_index * BUY_INTERVAL_PCT)

        if level_index not in buy_levels_triggered and price_hkd <= buy_price_level:
            cost = SHARES_PER_TRADE * price_hkd
            if cash >= cost:
                cash -= cost
                shares += SHARES_PER_TRADE
                buy_levels_triggered.add(level_index)

                trades.append({
                    'date': date.date(),
                    'action': 'BUY',
                    'price_hkd': price_hkd,
                    'shares': SHARES_PER_TRADE,
                    'amount_rmb': cost,
                    'cash': cash,
                    'total_shares': shares
                })
                print(f"📈 {date.date()} BUY:  HK${price_hkd:.2f} | 加仓 100 股 (¥{cost:,.0f}) | 档位 -{level_index*10}% | 持仓 {shares:.0f} 股")
            else:
                # 现金不足，记录但不执行
                print(f"⚠️  {date.date()} BUY SKIP: HK${price_hkd:.2f} | 现金不足 (需要 ¥{cost:,.0f}, 余额 ¥{cash:,.0f})")

    # 卖出逻辑：高于 580，每涨 10 HKD 减仓 1 手
    if price_hkd > SELL_TRIGGER and shares >= SHARES_PER_TRADE:
        rise_from_trigger = price_hkd - SELL_TRIGGER
        level_index = int(rise_from_trigger / SELL_INTERVAL)
        sell_price_level = SELL_TRIGGER + level_index * SELL_INTERVAL

        if level_index not in sell_levels_triggered and price_hkd >= sell_price_level:
            revenue = SHARES_PER_TRADE * price_hkd
            cash += revenue
            shares -= SHARES_PER_TRADE
            sell_levels_triggered.add(level_index)

            trades.append({
                'date': date.date(),
                'action': 'SELL',
                'price_hkd': price_hkd,
                'shares': SHARES_PER_TRADE,
                'amount_rmb': revenue,
                'cash': cash,
                'total_shares': shares
            })
            print(f"📉 {date.date()} SELL: HK${price_hkd:.2f} | 减仓 100 股 (¥{revenue:,.0f}) | 档位 +{level_index*10} HKD | 持仓 {shares:.0f} 股")

# 最终结果
final_price = float(tencent['Close'].iloc[-1])
final_value = cash + shares * final_price
total_return = (final_value - INITIAL_CAPITAL) / INITIAL_CAPITAL
annualized_return = (final_value / INITIAL_CAPITAL) ** (1/3) - 1

# 买入持有对比
buy_hold_shares = INITIAL_CAPITAL / initial_price
buy_hold_value = buy_hold_shares * final_price
buy_hold_return = (buy_hold_value - INITIAL_CAPITAL) / INITIAL_CAPITAL

print(f"\n{'='*70}")
print(f"回测结果总结")
print(f"{'='*70}")
print(f"\n📊 网格策略表现：")
print(f"  初始资金:     ¥{INITIAL_CAPITAL:,.0f}")
print(f"  最终价值:     ¥{final_value:,.0f}")
print(f"  总收益:       ¥{final_value - INITIAL_CAPITAL:,.0f}")
print(f"  总收益率:     {total_return*100:.2f}%")
print(f"  年化收益率:   {annualized_return*100:.2f}%")
print(f"\n💰 持仓明细：")
print(f"  现金余额:     ¥{cash:,.0f} ({cash/final_value*100:.1f}%)")
print(f"  持有股数:     {shares:.0f} 股")
print(f"  股票市值:     ¥{shares * final_price:,.0f} ({shares*final_price/final_value*100:.1f}%)")
print(f"  当前股价:     HK${final_price:.2f}")
print(f"\n📈 对比买入持有：")
print(f"  买入持有价值: ¥{buy_hold_value:,.0f}")
print(f"  买入持有收益: {buy_hold_return*100:.2f}%")
print(f"  策略差异:     {(total_return - buy_hold_return)*100:+.2f}%")
print(f"\n📝 交易统计：")
print(f"  总交易次数:   {len(trades)} 次")
print(f"  买入次数:     {sum(1 for t in trades if t['action'] == 'BUY')} 次")
print(f"  卖出次数:     {sum(1 for t in trades if t['action'] == 'SELL')} 次")
print(f"\n📊 价格区间：")
print(f"  初始价格:     HK${initial_price:.2f}")
print(f"  最低价格:     HK${float(tencent['Close'].min()):.2f}")
print(f"  最高价格:     HK${float(tencent['Close'].max()):.2f}")
print(f"  最终价格:     HK${final_price:.2f}")

# 保存交易记录
if trades:
    df_trades = pd.DataFrame(trades)
    df_trades.to_csv('/Users/bytedance/re-act/trades_TCEHY_grid_v2.csv', index=False)
    print(f"\n✓ 交易记录已保存至 trades_TCEHY_grid_v2.csv")
