#!/usr/bin/env python3
"""
苹果股票交易策略回测
策略：
1. 初始投入 100 万买入苹果股票
2. 价格上涨 30% 后触发卖出机制：每再上涨 10%，卖出持仓的 5%
3. 当价格跌回到卖出价位以下 10% 时，买入 5%
"""

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

# 配置
INITIAL_CAPITAL = 1_000_000  # 初始资金 100 万
TRIGGER_GAIN = 0.30          # 触发卖出的初始涨幅 30%
SELL_INTERVAL = 0.10         # 每上涨 10% 卖出一次
SELL_RATIO = 0.05            # 每次卖出持仓的 5%
BUY_BACK_DROP = 0.10         # 跌回 10% 时买入
BUY_RATIO = 0.05             # 每次买入 5%

# 获取苹果股票 3 年历史数据
print("正在获取苹果股票历史数据...")
end_date = datetime.now()
start_date = end_date - timedelta(days=3*365)
aapl = yf.download('AAPL', start=start_date, end=end_date, progress=False)

if aapl.empty:
    print("❌ 无法获取数据")
    exit(1)

print(f"✓ 获取到 {len(aapl)} 天的数据 ({aapl.index[0].date()} ~ {aapl.index[-1].date()})")

# 初始化
initial_price = float(aapl['Close'].iloc[0])
cash = 0  # 初始全仓买入，现金为 0
shares = INITIAL_CAPITAL / initial_price  # 持有股数
cost_basis = initial_price  # 成本价

# 交易记录
trades = []
sell_levels = []  # 记录每次卖出的价格水平，用于判断买回时机

print(f"\n初始状态：")
print(f"  买入价格: ${initial_price:.2f}")
print(f"  买入股数: {shares:.2f}")
print(f"  触发价格: ${initial_price * (1 + TRIGGER_GAIN):.2f} (+30%)")
print(f"\n开始回测...\n")

# 回测循环
for date, row in aapl.iterrows():
    price = float(row['Close'])
    gain_from_cost = (price - cost_basis) / cost_basis

    # 策略 1: 上涨 30% 后，每再涨 10% 卖出 5%
    if gain_from_cost >= TRIGGER_GAIN:
        # 计算当前应该在哪个卖出档位
        levels_above_trigger = int((gain_from_cost - TRIGGER_GAIN) / SELL_INTERVAL)
        target_sell_level = cost_basis * (1 + TRIGGER_GAIN + levels_above_trigger * SELL_INTERVAL)

        # 如果价格突破了新的卖出档位
        if not sell_levels or price > max(sell_levels) * (1 + SELL_INTERVAL):
            sell_shares = shares * SELL_RATIO
            sell_amount = sell_shares * price
            cash += sell_amount
            shares -= sell_shares
            sell_levels.append(price)

            trades.append({
                'date': date.date(),
                'action': 'SELL',
                'price': price,
                'shares': sell_shares,
                'amount': sell_amount,
                'gain': f"+{gain_from_cost*100:.1f}%",
                'cash': cash,
                'position': shares
            })
            print(f"📉 {date.date()} SELL: ${price:.2f} | 卖出 {sell_shares:.2f} 股 (${sell_amount:,.0f}) | 涨幅 +{gain_from_cost*100:.1f}%")

    # 策略 2: 跌回卖出价位以下 10% 时买入 5%
    if sell_levels:
        for sell_price in sell_levels[:]:
            buy_back_price = sell_price * (1 - BUY_BACK_DROP)
            if price <= buy_back_price and cash > 0:
                # 计算买入金额（当前总资产的 5%）
                total_value = cash + shares * price
                buy_amount = min(total_value * BUY_RATIO, cash)  # 不超过现金余额
                buy_shares = buy_amount / price

                if buy_shares > 0:
                    cash -= buy_amount
                    shares += buy_shares
                    sell_levels.remove(sell_price)  # 移除这个卖出档位

                    trades.append({
                        'date': date.date(),
                        'action': 'BUY',
                        'price': price,
                        'shares': buy_shares,
                        'amount': buy_amount,
                        'gain': f"{gain_from_cost*100:+.1f}%",
                        'cash': cash,
                        'position': shares
                    })
                    print(f"📈 {date.date()} BUY:  ${price:.2f} | 买入 {buy_shares:.2f} 股 (${buy_amount:,.0f}) | 回调至 ${sell_price:.2f} 以下")

# 最终结果
final_price = float(aapl['Close'].iloc[-1])
final_value = cash + shares * final_price
total_return = (final_value - INITIAL_CAPITAL) / INITIAL_CAPITAL
annualized_return = (final_value / INITIAL_CAPITAL) ** (1/3) - 1

# 对比买入持有策略
buy_hold_shares = INITIAL_CAPITAL / initial_price
buy_hold_value = buy_hold_shares * final_price
buy_hold_return = (buy_hold_value - INITIAL_CAPITAL) / INITIAL_CAPITAL

print(f"\n{'='*70}")
print(f"回测结果总结")
print(f"{'='*70}")
print(f"\n📊 策略表现：")
print(f"  初始投入:     ${INITIAL_CAPITAL:,.0f}")
print(f"  最终价值:     ${final_value:,.0f}")
print(f"  总收益:       ${final_value - INITIAL_CAPITAL:,.0f}")
print(f"  总收益率:     {total_return*100:.2f}%")
print(f"  年化收益率:   {annualized_return*100:.2f}%")
print(f"\n💰 持仓明细：")
print(f"  现金余额:     ${cash:,.0f}")
print(f"  持有股数:     {shares:.2f}")
print(f"  股票市值:     ${shares * final_price:,.0f}")
print(f"  当前股价:     ${final_price:.2f}")
print(f"\n📈 对比买入持有策略：")
print(f"  买入持有价值: ${buy_hold_value:,.0f}")
print(f"  买入持有收益: {buy_hold_return*100:.2f}%")
print(f"  策略差异:     {(total_return - buy_hold_return)*100:+.2f}%")
print(f"\n📝 交易统计：")
print(f"  总交易次数:   {len(trades)} 次")
print(f"  卖出次数:     {sum(1 for t in trades if t['action'] == 'SELL')} 次")
print(f"  买入次数:     {sum(1 for t in trades if t['action'] == 'BUY')} 次")

# 保存交易记录
if trades:
    df_trades = pd.DataFrame(trades)
    df_trades.to_csv('/Users/bytedance/re-act/trades_log.csv', index=False)
    print(f"\n✓ 交易记录已保存至 trades_log.csv")
