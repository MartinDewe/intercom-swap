Instructions for Agent

This project is a local Mini DEX (Decentralized Exchange) simulator built with React and Tailwind CSS. The purpose of this application is to simulate token swaps using an Automated Market Maker (AMM) model.

Objective

The agent (user) should:

Simulate ETH → USDC swaps

Observe price changes after each transaction

Understand slippage effects

Analyze how liquidity pools behave under different swap sizes

How to Operate the Simulator

Start the application locally using:

npm run dev


Open the browser at:

http://localhost:5173


Enter an ETH amount in the input field.

Observe the estimated USDC output calculated automatically.

Click the Swap button to execute the simulated trade.

Review updated:

ETH liquidity

USDC liquidity

Current price

Swap output

Expected Behavior

The system uses a constant product formula (x * y = k).

A 0.3% swap fee is applied.

Larger swaps result in higher slippage.

Pool liquidity updates dynamically after each swap.

Limitations

This is a simulation only.

No blockchain interaction.

No wallet integration.

No real token transfers.

The agent should use this simulator to understand AMM mechanics and DEX pricing behavior in a controlled local environment.
