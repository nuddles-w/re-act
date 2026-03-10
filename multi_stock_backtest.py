#!/usr/bin/env python3
"""
多股票交易策略回测
对比苹果、英伟达、谷歌、罗克希尔的策略表现
"""

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

# 配置
INITIAL_CAPITAL = 1_000_000
TRIGGER_GAIN = 0.30
SELL_INTERVAL = 0.10
SELL_RATIO = 0.05
BUY_BACK_DROP = 0.10
BUY_RATIO = 0.05

# 股票列表
STOCKS = {
    'AAPL': '苹果',
    'NVDA': '英伟达',
    'GOOGL': '谷歌',
    'ROK': '罗克韦尔自动化'  # Rockwell Automation
}

def backtest_stock(ticker, name):
    """对单只股票执行回测"""
    print(f"\n{'='*70}")
    print(f"正在回测: {name} ({ticker})")
    print(f"{'='*70}")

    # 获取历史数据
    end_date = datetime.now()
    start_date = end_date - timedelta(days=3*365)

    try:
        data = yf.download(ticker, start=start_date, end=end_date, progress=False)
    except Exception as e:
        print(f"❌ 获取 {name} 数据失败: {e}")
        return None

    if data.empty:
        print(f"❌ {name} 无数据")
        return None

    print(f"✓ 获取到 {len(data)} 天的数据 ({data.index[0].date()} ~ {data.index[-1].date()})")

    # 初始化
    initial_price = float(data['Close'].iloc[0])
    cash = 0
    shares = INITIAL_CAPITAL / initial_price
    cost_basis = initial_price

    trades = []
    sell_levels = []

    print(f"  初始价格: ${initial_price:.2f}")
    print(f"  初始股数: {shares:.2f}")
    print(f"  触发价格: ${initial_price * (1 + TRIGGER_GAIN):.2f} (+30%)\n")

    # 回测循环
    for date, row in data.iterrows():
        price = float(row['Close'])
        gain_from_cost = (price - cost_basis) / cost_basis

        # 卖出逻辑
        if gain_from_cost >= TRIGGER_GAIN:
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
                    'gain_pct': gain_from_cost * 100
                })

        # 买入逻辑
        if sell_levels:
            for sell_price in sell_levels[:]:
                buy_back_price = sell_price * (1 - BUY_BACK_DROP)
                if price <= buy_back_price and cash > 0:
                    total_value = cash + shares * price
                    buy_amount = min(total_value * BUY_RATIO, cash)
                    buy_shares = buy_amount / price

                    if buy_shares > 0:
                        cash -= buy_amount
                        shares += buy_shares
                        sell_levels.remove(sell_price)

                        trades.append({
                            'date': date.date(),
                            'action': 'BUY',
                            'price': price,
                            'shares': buy_shares,
                            'amount': buy_amount,
                            'gain_pct': gain_from_cost * 100
                        })

    # 计算最终结果
    final_price = float(data['Close'].iloc[-1])
    final_value = cash + shares * final_price
    total_return = (final_value - INITIAL_CAPITAL) / INITIAL_CAPITAL
    annualized_return = (final_value / INITIAL_CAPITAL) ** (1/3) - 1

    # 买入持有对比
    buy_hold_shares = INITIAL_CAPITAL / initial_price
    buy_hold_value = buy_hold_shares * final_price
    buy_hold_return = (buy_hold_value - INITIAL_CAPITAL) / INITIAL_CAPITAL

    # 输出结果
    print(f"📊 策略表现：")
    print(f"  最终价值:     ${final_value:,.0f}")
    print(f"  总收益率:     {total_return*100:.2f}%")
    print(f"  年化收益率:   {annualized_return*100:.2f}%")
    print(f"\n💰 持仓明细：")
    print(f"  现金:         ${cash:,.0f} ({cash/final_value*100:.1f}%)")
    print(f"  股票市值:     ${shares * final_price:,.0f} ({shares*final_price/final_value*100:.1f}%)")
    print(f"  当前股价:     ${final_price:.2f}")
    print(f"\n📈 对比买入持有：")
    print(f"  买入持有价值: ${buy_hold_value:,.0f}")
    print(f"  买入持有收益: {buy_hold_return*100:.2f}%")
    print(f"  策略差异:     {(total_return - buy_hold_return)*100:+.2f}%")
    print(f"\n📝 交易统计：")
    print(f"  总交易:       {len(trades)} 次")
    print(f"  卖出:         {sum(1 for t in trades if t['action'] == 'SELL')} 次")
    print(f"  买入:         {sum(1 for t in trades if t['action'] == 'BUY')} 次")

    # 保存交易记录
    if trades:
        df_trades = pd.DataFrame(trades)
        df_trades.to_csv(f'/Users/bytedance/re-act/trades_{ticker}.csv', index=False)
        print(f"  ✓ 交易记录已保存至 trades_{ticker}.csv")

    return {
        'ticker': ticker,
        'name': name,
        'initial_price': initial_price,
        'final_price': final_price,
        'final_value': final_value,
        'total_return': total_return,
        'annualized_return': annualized_return,
        'buy_hold_value': buy_hold_value,
        'buy_hold_return': buy_hold_return,
        'strategy_diff': total_return - buy_hold_return,
        'cash': cash,
        'shares': shares,
        'num_trades': len(trades),
        'num_sells': sum(1 for t in trades if t['action'] == 'SELL'),
        'num_buys': sum(1 for t in trades if t['action'] == 'BUY')
    }

# 执行回测
results = []
for ticker, name in STOCKS.items():
    result = backtest_stock(ticker, name)
    if result:
        results.append(result)

# 汇总对比
print(f"\n\n{'='*70}")
print(f"汇总对比")
print(f"{'='*70}\n")

df_summary = pd.DataFrame(results)
df_summary = df_summary.sort_values('total_return', ascending=False)

print(f"{'股票':<12} {'总收益率':<12} {'年化收益':<12} {'vs买入持有':<12} {'交易次数':<10}")
print(f"{'-'*70}")
for _, row in df_summary.iterrows():
    print(f"{row['name']:<10} {row['total_return']*100:>10.2f}%  {row['annualized_return']*100:>10.2f}%  {row['strategy_diff']*100:>10.2f}%  {row['num_trades']:>8}次")

# 保存汇总
df_summary.to_csv('/Users/bytedance/re-act/backtest_summary.csv', index=False)
print(f"\n✓ 汇总结果已保存至 backtest_summary.csv")
