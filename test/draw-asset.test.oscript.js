// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai');
const Decimal = require('decimal.js');
const path = require('path');

describe('Check prediction AA: 2', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ predictionBaseAgent: path.join(__dirname, "../agent.oscript") })
			.with.agent({ predictionFactoryAgent: path.join(__dirname, "../factory.oscript") })
			.with.agent({ forwarderAgent: path.join(__dirname, "../define-asset-forwarder.oscript") })
			.with.asset({ reserveAsset: {} })
			.with.wallet({ alice: { base: 50e9, reserveAsset: 50e9 } })
			.with.wallet({ bob: { base: 10e9, reserveAsset: 50e9 } })
			.with.wallet({ oracleOperator: 10e9 })
			.run();

		this.reserve_asset = this.network.asset.reserveAsset;
		this.alice = this.network.wallet.alice;
		this.aliceAddress = await this.alice.getAddress();

		this.bob = this.network.wallet.bob;
		this.bobAddress = await this.bob.getAddress();

		this.oracleOperator = this.network.wallet.oracleOperator;
		this.oracleOperatorAddress = await this.oracleOperator.getAddress();

		this.waiting_period_length = 3 * 24 * 3600;
		this.current_timestamp = Math.floor(Date.now() / 1000);
		this.end_of_trading_period = this.current_timestamp + 30 * 24 * 3600;

		this.coef = 1;

		this.feed_name = "FEED_NAME";
		this.datafeed_value = 'YES';
		this.issue_fee = 0.01;
		this.redeem_fee = 0.02;
		this.supply_yes = 0;
		this.supply_no = 0;
		this.supply_draw = 0;
		this.reserve = 0;

		this.buy = (amount_yes, amount_no, amount_draw, readOnly) => {
			const BN = (num) => new Decimal(num);

			const new_reserve = Math.ceil(this.coef * Math.sqrt((this.supply_yes + amount_yes) ** 2 + (this.supply_no + amount_no) ** 2 + (this.supply_draw + amount_draw) ** 2));

			const reserve_delta = new_reserve - this.reserve;
			const reserve_needed = reserve_delta > 0 ? reserve_delta : 0;

			const payout = reserve_delta < 0 ? Math.abs(reserve_delta) : 0;

			const fee = Math.ceil(reserve_needed * this.issue_fee + payout * this.redeem_fee);

			const next_coef = this.coef * ((new_reserve + fee) / new_reserve);
			const bn_next_coef = BN(this.coef).mul((new_reserve + fee) / new_reserve).toNumber()

			if (!readOnly) {
				this.reserve = new_reserve + fee;
				this.coef = bn_next_coef;
				this.supply_yes += amount_yes;
				this.supply_no += amount_no;
				this.supply_draw += amount_draw;
			}

			return {
				new_reserve,
				reserve_needed,
				fee,
				payout
			}
		}
	});

	it('Create prediction', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.predictionFactoryAgent,
			amount: 20000,
			data: {
				event: "New year",
				oracle: this.oracleOperatorAddress,
				comparison: "==",
				feed_name: this.feed_name,
				allow_draw: true,
				datafeed_value: this.datafeed_value,
				end_of_trading_period: this.end_of_trading_period,
				waiting_period_length: this.waiting_period_length,
				reserve_asset: this.reserve_asset
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.false;

		expect(response.response.responseVars.prediction_address).to.exist;

		this.prediction_address = response.response.responseVars.prediction_address;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		const { vars: vars2 } = await this.bob.readAAStateVars(this.network.agent.predictionFactoryAgent);

		expect(vars1.yes_asset).to.exist;
		expect(vars1.no_asset).to.exist;
		expect(vars1.draw_asset).to.exist;

		const params = vars2[`prediction_${this.prediction_address}`];

		expect(params.yes_asset).to.exist;
		expect(params.no_asset).to.exist;
		expect(params.draw_asset).to.exist;

		expect(params.yes_asset).to.be.equal(vars1.yes_asset);
		expect(params.no_asset).to.be.equal(vars1.no_asset);
		expect(params.draw_asset).to.be.equal(vars1.draw_asset);

		this.yes_asset = vars1.yes_asset;
		this.no_asset = vars1.no_asset;
		this.draw_asset = vars1.draw_asset;
	});

	it('Alice issue tokens', async () => {
		const yes_amount = 0.5 * 1e9;
		const no_amount = 0.5 * 1e9;
		const draw_amount = 0.5 * 1e9;

		const amount = 1e9;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		const res = this.buy(yes_amount, no_amount, draw_amount);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		await this.network.witnessUntilStable(response.response_unit);

		expect(response.bounced).to.be.false;

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars1.supply_yes).to.be.equal(yes_amount);
		expect(vars1.supply_no).to.be.equal(no_amount);
		expect(vars1.supply_draw).to.be.equal(draw_amount);
		expect(vars1.reserve).to.be.equal(this.reserve);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: amount - res.reserve_needed - res.fee
			},
		]);

		this.alice_yes_amount = yes_amount;
		this.alice_no_amount = no_amount;
		this.alice_draw_amount = draw_amount;

		this.supply_yes = yes_amount;
		this.supply_no = no_amount;
		this.supply_draw = draw_amount;

	});

	it('Alice issue tokens (not enough reserve)', async () => {
		const yes_amount = 0.0051e9;
		const no_amount = 0.0251e9;
		const draw_amount = 0.0051e9;

		const res = this.buy(yes_amount, no_amount, draw_amount, true);

		const amount = 10001;

		const { unit, error } = await this.alice.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})


		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal(`expected reserve amount: ${Math.abs(res.reserve_needed + res.fee)}`);
	});

	it('Alice redeem yes tokens', async () => {
		const yes_amount_redeem = 0.3 * 1e9;
		this.alice_yes_amount = this.alice_yes_amount - yes_amount_redeem;

		const res = this.buy(-yes_amount_redeem, 0, 0);

		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: yes_amount_redeem }],
		});

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit);

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit });

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);
		expect(vars1.reserve).to.be.equal(this.reserve);

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.reserve_asset,
				amount: res.payout - res.fee
			},
		]);
	});

	it('Bob issue tokens', async () => {
		const yes_amount = 2432250;
		const no_amount = 142350;
		const draw_amount = 5421500;

		const res = this.buy(yes_amount, no_amount, draw_amount);

		const amount = 150000000;

		const { unit, error } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		await this.network.witnessUntilStable(response.response_unit);

		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		expect(vars1.supply_no).to.be.equal(this.supply_no);
		expect(vars1.supply_draw).to.be.equal(this.supply_draw);
		expect(vars1.reserve).to.be.equal(this.reserve);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				asset: this.yes_asset,
				amount: yes_amount,
			},
			{
				address: this.bobAddress,
				asset: this.no_asset,
				amount: no_amount,
			},
			{
				address: this.bobAddress,
				asset: this.draw_asset,
				amount: draw_amount,
			},
			{
				address: this.bobAddress,
				asset: this.reserve_asset,
				amount: amount - res.reserve_needed - res.fee,
			},
		]);

		this.bob_yes_amount = yes_amount;
		this.bob_no_amount = no_amount;
		this.bob_draw_amount = draw_amount;
	});

	it('Bob issues tokens by type', async () => {

		const res = this.buy(2e7, 0, 0);
		const amount = res.reserve_needed + res.fee;

		const { unit, error } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			asset_outputs: [{ address: this.prediction_address, amount }],
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			messages: [{
				app: 'data',
				payload: {
					type: 'yes'
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		await this.network.witnessUntilStable(response.response_unit);

		expect(response.bounced).to.be.false;
		const { vars: vars1 } = await this.bob.readAAStateVars(this.prediction_address);

		// expect(vars1.supply_yes).to.be.equal(this.supply_yes);
		// expect(vars1.supply_no).to.be.equal(this.supply_no);
		// expect(vars1.reserve).to.be.equal(this.reserve);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				asset: this.yes_asset,
				amount: 2e7,
			},
			{
				asset: this.reserve_asset,
				address: this.bobAddress,
				amount: 0
			},
		]);

		this.bob_yes_amount += 5e7;
	});
	
	it('Bob issues tokens after the period expires', async () => {
		const { error } = await this.network.timetravel({ shift: (this.end_of_trading_period - this.current_timestamp + 100) * 1000 });
		expect(error).to.be.null;

		const yes_amount = 250;
		const no_amount = 250;
		const draw_amount = 150;

		const amount = 1e9;

		const { unit, error: error2 } = await this.bob.sendMulti({
			asset: this.reserve_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount }],
			messages: [{
				app: 'data',
				payload: {
					yes_amount,
					no_amount,
					draw_amount
				}
			}]
		})

		expect(error2).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.bounced).to.be.true;
		expect(response.response.error).to.equal("the trading period is closed");
	});

	it('Bob commit result (without data_value)', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.prediction_address,
			amount: 1e4,
			data: {
				commit: 1
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);

		expect(response.response.error).to.be.equal("data_feed is empty");
	});


	it('Alice claim profit (no result)', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_yes_amount }],
			messages: [{
				app: 'data',
				payload: {
					claim_profit: 1
				}
			}]
		});

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		expect(response.response.error).to.be.equal("no results yet");
	});

	it('Operator posts data feed', async () => {
		const { unit, error } = await this.oracleOperator.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					[this.feed_name]: this.datafeed_value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracleOperator.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload[this.feed_name]).to.be.equal(this.datafeed_value)
		await this.network.witnessUntilStable(unit);
	})

	it('Bob commit result', async () => {
		const { unit, error } = await this.network.wallet.bob.triggerAaWithData({
			toAddress: this.prediction_address,
			amount: 1e4,
			data: {
				commit: 1
			}
		});

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit);
		expect(response.bounced).to.be.false;
		expect(response.response.responseVars.messages).to.be.equal('The result is committed');

		const { vars } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars.result).to.be.equal('yes');
		this.reserve = response.balances[this.reserve_asset];
	});

	it('Alice claim profit', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.yes_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_yes_amount }],
			messages: [{
				app: 'data',
				payload: {
					claim_profit: 1
				}
			}]
		});

		const price = (this.reserve / this.supply_yes);
		const expect_payout = Math.floor(price * this.alice_yes_amount);

		this.supply_yes -= this.alice_yes_amount;

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);
		expect(response.response.responseVars['Your profit']).to.be.equal(expect_payout);
		expect(response.bounced).to.be.false;

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit });
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: expect_payout,
				asset: this.reserve_asset
			},
		]);

		expect(error).to.be.null;
		expect(unit).to.be.validUnit;

		const { vars } = await this.bob.readAAStateVars(this.prediction_address);
		expect(vars.supply_yes).to.be.equal(this.supply_yes);
	});

	it('Alice send lose token', async () => {
		const { unit } = await this.alice.sendMulti({
			asset: this.no_asset,
			base_outputs: [{ address: this.prediction_address, amount: 1e4 }],
			asset_outputs: [{ address: this.prediction_address, amount: this.alice_no_amount }],
			messages: [{
				app: 'data',
				payload: {
					claim_profit: 1
				}
			}]
		});

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit);
		expect(response.bounced).to.be.true;
		expect(response.response.error).to.be.equal("you are sending not a winner token")
	});

	after(async () => {
		await this.network.stop()
	})
})
