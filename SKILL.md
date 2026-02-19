🧪 Mini DEX Simulator — How to Use

This project is a local simulation of a Decentralized Exchange (DEX) using an Automated Market Maker (AMM) model based on the constant product formula:

x * y = k


It simulates token swaps between ETH and USDC without connecting to any blockchain.

🚀 1. Installation

Make sure you have Node.js v18+ installed.

Clone or navigate to the project folder:
cd dex-ui

Install dependencies:
npm install

▶️ 2. Run the Project

Start the development server:

npm run dev


Open your browser and go to:

http://localhost:5173


You should see the Mini DEX interface running locally.

💱 3. How the Swap Works

The simulator uses a constant product AMM formula:

x * y = k


Where:

x = ETH liquidity in the pool

y = USDC liquidity in the pool

k = constant value

Each swap:

Adds ETH to the pool

Calculates USDC output based on AMM formula

Applies a 0.3% fee

Updates the pool liquidity

The price automatically adjusts after every swap.

🧮 4. Performing a Swap

Enter an amount of ETH in the input field.

The estimated USDC output will update automatically.

Click Swap.

The liquidity pool updates and the new price is calculated.

Try:

Small swaps (0.1 ETH)

Large swaps (10 ETH)

You’ll notice higher slippage for larger swaps.

📊 5. What This Project Demonstrates

Automated Market Maker (AMM) mechanics

Slippage simulation

Liquidity pool dynamics

Fee accumulation (0.3%)

Real-time price recalculation

This is similar to early AMM models used by platforms like Uniswap.

⚠️ Important Notes

This is a local simulation only

No real blockchain interaction

No wallet connection

No real tokens are used

It is designed for learning and UI demonstration purposes.
