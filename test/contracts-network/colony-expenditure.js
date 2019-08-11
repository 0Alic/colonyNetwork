/* global artifacts */
import chai from "chai";
import bnChai from "bn-chai";

import { WAD } from "../../helpers/constants";
import { checkErrorRevert, getTokenArgs } from "../../helpers/test-helper";
import { fundColonyWithTokens, setupRandomColony } from "../../helpers/test-data-generator";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const EtherRouter = artifacts.require("EtherRouter");
const IColonyNetwork = artifacts.require("IColonyNetwork");
const IMetaColony = artifacts.require("IMetaColony");
const Token = artifacts.require("Token");

contract("Colony Expenditure", accounts => {
  const RECIPIENT = accounts[3];
  const ADMIN = accounts[4];
  const USER = accounts[10];

  const ACTIVE = 0;
  const CANCELLED = 1;
  const FINALIZED = 2;

  let colony;
  let token;
  let otherToken;
  let colonyNetwork;
  let metaColony;

  before(async () => {
    const etherRouter = await EtherRouter.deployed();
    colonyNetwork = await IColonyNetwork.at(etherRouter.address);
    const metaColonyAddress = await colonyNetwork.getMetaColony();
    metaColony = await IMetaColony.at(metaColonyAddress);

    ({ colony, token } = await setupRandomColony(colonyNetwork));
    await colony.setRewardInverse(100);
    await colony.setAdministrationRole(1, 0, ADMIN, 1, true);
    await fundColonyWithTokens(colony, token, WAD.muln(20));

    const tokenArgs = getTokenArgs();
    otherToken = await Token.new(...tokenArgs);
    await otherToken.unlock();
  });

  describe("when adding expenditures", () => {
    it("should allow admins to add expenditure", async () => {
      const expendituresCountBefore = await colony.getExpenditureCount();
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });

      const expendituresCountAfter = await colony.getExpenditureCount();
      expect(expendituresCountAfter.sub(expendituresCountBefore)).to.eq.BN(1);

      const fundingPotId = await colony.getFundingPotCount();
      const expenditure = await colony.getExpenditure(expendituresCountAfter);

      expect(expenditure.fundingPotId).to.eq.BN(fundingPotId);
      expect(expenditure.domainId).to.eq.BN(1);

      const fundingPot = await colony.getFundingPot(fundingPotId);
      expect(fundingPot.associatedType).to.eq.BN(4); // 4 = FundingPotAssociatedType.Expenditure
      expect(fundingPot.associatedTypeId).to.eq.BN(expendituresCountAfter);
    });

    it("should not allow non-admins to add expenditure", async () => {
      await checkErrorRevert(colony.makeExpenditure(1, 0, 1, { from: USER }), "ds-auth-unauthorized");
    });

    it("should allow owners to cancel expenditures", async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      const expenditureId = await colony.getExpenditureCount();

      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(ACTIVE);

      await checkErrorRevert(colony.cancelExpenditure(expenditureId, { from: USER }), "colony-expenditure-not-owner");
      await colony.cancelExpenditure(expenditureId, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(CANCELLED);
      expect(expenditure.finalizedTimestamp).to.be.zero;
    });

    it("should allow owners to transfer expenditures", async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      const expenditureId = await colony.getExpenditureCount();

      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.owner).to.equal(ADMIN);

      await checkErrorRevert(colony.transferExpenditure(expenditureId, USER), "colony-expenditure-not-owner");
      await colony.transferExpenditure(expenditureId, USER, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.owner).to.equal(USER);
    });
  });

  describe("when updating expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should allow owners to update a recipient skill", async () => {
      let recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.skills.length).to.be.zero;

      await colony.setExpenditureSkill(expenditureId, RECIPIENT, 3, { from: ADMIN });
      recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.skills[0]).to.eq.BN(3);
    });

    it("should not allow owners to set a deprecated global skill", async () => {
      await metaColony.addGlobalSkill();
      const skillId = await colonyNetwork.getSkillCount();
      await metaColony.deprecateGlobalSkill(skillId);

      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, skillId, { from: ADMIN }), "colony-deprecated-global-skill");
    });

    it("should not allow non-owners to update skills or payouts", async () => {
      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, 3), "colony-expenditure-not-owner");
      await checkErrorRevert(colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD), "colony-expenditure-not-owner");
    });

    it("should allow owners to add a recipient payout", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const recipient = await colony.getExpenditureRecipient(expenditureId, RECIPIENT);
      expect(recipient.payoutScalar).to.eq.BN(WAD);

      const payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.eq.BN(WAD);
    });

    it("should be able to add multiple payouts in different tokens", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, otherToken.address, 100, { from: ADMIN });

      const payoutForToken = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      const payoutForOtherToken = await colony.getExpenditurePayout(expenditureId, RECIPIENT, otherToken.address);
      expect(payoutForToken).to.eq.BN(WAD);
      expect(payoutForOtherToken).to.eq.BN(100);
    });

    it("should allow owner to set token payout to zero", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      let payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.eq.BN(WAD);

      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, 0, { from: ADMIN });

      payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.be.zero;
    });

    it("should correctly account for multiple payouts in the same token", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });
      await colony.setExpenditurePayout(expenditureId, ADMIN, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      let totalPayout = await colony.getFundingPotPayout(expenditure.fundingPotId, token.address);
      expect(totalPayout).to.eq.BN(WAD.muln(2));

      await colony.setExpenditurePayout(expenditureId, ADMIN, token.address, 0, { from: ADMIN });

      totalPayout = await colony.getFundingPotPayout(expenditure.fundingPotId, token.address);
      expect(totalPayout).to.eq.BN(WAD);
    });
  });

  describe("when finalizing expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should allow owners to finalize expenditures", async () => {
      let expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(ACTIVE);

      await checkErrorRevert(colony.finalizeExpenditure(expenditureId, { from: USER }), "colony-expenditure-not-owner");
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      expenditure = await colony.getExpenditure(expenditureId);
      expect(expenditure.status).to.eq.BN(FINALIZED);
      expect(expenditure.finalizedTimestamp).to.not.be.zero;
    });

    it("cannot finalize expenditure if it is not fully funded", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      await checkErrorRevert(colony.finalizeExpenditure(expenditureId, { from: ADMIN }), "colony-expenditure-not-funded");

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);

      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
    });

    it("should not allow admins to update payouts", async () => {
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await checkErrorRevert(
        colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN }),
        "colony-expenditure-not-active"
      );
    });

    it("should not allow admins to update skills", async () => {
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await checkErrorRevert(colony.setExpenditureSkill(expenditureId, RECIPIENT, 1, { from: ADMIN }), "colony-expenditure-not-active");
    });
  });

  describe.only("when claiming expenditures", () => {
    let expenditureId;

    beforeEach(async () => {
      await colony.makeExpenditure(1, 0, 1, { from: ADMIN });
      expenditureId = await colony.getExpenditureCount();
    });

    it("should allow anyone to claim on behalf of the recipient, with network fee deducted", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });

      const recipientBalanceBefore = await token.balanceOf(RECIPIENT);
      const networkBalanceBefore = await token.balanceOf(colonyNetwork.address);
      await colony.claimExpenditure(expenditureId, RECIPIENT, token.address);

      const recipientBalanceAfter = await token.balanceOf(RECIPIENT);
      const networkBalanceAfter = await token.balanceOf(colonyNetwork.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq.BN(WAD.muln(100).divn(99));
      expect(networkBalanceAfter.sub(networkBalanceBefore)).to.eq.BN(WAD.sub(WAD.muln(100).divn(99)));
    });

    it("after expenditure is claimed it should set the payout to 0", async () => {
      await colony.setExpenditurePayout(expenditureId, RECIPIENT, token.address, WAD, { from: ADMIN });

      const expenditure = await colony.getExpenditure(expenditureId);
      await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, WAD, token.address);
      await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
      await colony.claimExpenditure(expenditureId, RECIPIENT, token.address);

      const payout = await colony.getExpenditurePayout(expenditureId, RECIPIENT, token.address);
      expect(payout).to.be.zero;
    });

    it("should error when expenditure is not finalized", async () => {
      await checkErrorRevert(colony.claimExpenditure(expenditureId, RECIPIENT, token.address), "colony-expenditure-not-finalized");
    });

    // it("should allow multiple payouts to be claimed", async () => {
    //   await colony.makeExpenditure(1, 0, RECIPIENT, token.address, 200, 1, 0, { from: ADMIN });
    //   const expenditureId = await colony.getExpenditureCount();
    //   let expenditure = await colony.getExpenditure(expenditureId);

    //   await colony.setExpenditurePayout(1, 0, expenditureId, otherToken.address, 100);
    //   await fundColonyWithTokens(colony, otherToken, 101);
    //   let fundingPot = await colony.getFundingPot(expenditure.fundingPotId);
    //   expect(fundingPot.payoutsWeCannotMake).to.eq.BN(2);

    //   await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, 199, token.address);
    //   fundingPot = await colony.getFundingPot(expenditure.fundingPotId);
    //   expect(fundingPot.payoutsWeCannotMake).to.eq.BN(2);

    //   await colony.moveFundsBetweenPots(1, 0, 0, 1, expenditure.fundingPotId, 100, otherToken.address);
    //   fundingPot = await colony.getFundingPot(expenditure.fundingPotId);
    //   expect(fundingPot.payoutsWeCannotMake).to.eq.BN(1);

    //   await colony.setExpenditurePayout(1, 0, expenditureId, token.address, 199);
    //   fundingPot = await colony.getFundingPot(expenditure.fundingPotId);
    //   expect(fundingPot.payoutsWeCannotMake).to.be.zero;

    //   await colony.finalizeExpenditure(expenditureId, { from: ADMIN });
    //   expenditure = await colony.getExpenditure(expenditureId);
    //   expect(expenditure.finalized).to.be.true;

    //   const recipientBalanceBefore1 = await token.balanceOf(RECIPIENT);
    //   const networkBalanceBefore1 = await token.balanceOf(colonyNetwork.address);
    //   await colony.claimExpenditure(expenditureId, token.address);

    //   const recipientBalanceAfter1 = await token.balanceOf(RECIPIENT);
    //   const networkBalanceAfter1 = await token.balanceOf(colonyNetwork.address);
    //   expect(recipientBalanceAfter1.sub(recipientBalanceBefore1)).to.eq.BN(new BN("197"));
    //   expect(networkBalanceAfter1.sub(networkBalanceBefore1)).to.eq.BN(new BN("2"));

    //   const recipientBalanceBefore2 = await otherToken.balanceOf(RECIPIENT);
    //   const networkBalanceBefore2 = await otherToken.balanceOf(colonyNetwork.address);
    //   await colony.claimExpenditure(expenditureId, otherToken.address);

    //   const recipientBalanceAfter2 = await otherToken.balanceOf(RECIPIENT);
    //   const networkBalanceAfter2 = await otherToken.balanceOf(colonyNetwork.address);
    //   expect(recipientBalanceAfter2.sub(recipientBalanceBefore2)).to.eq.BN(new BN("98"));
    //   expect(networkBalanceAfter2.sub(networkBalanceBefore2)).to.eq.BN(new BN("2"));
    // });
  });
});
