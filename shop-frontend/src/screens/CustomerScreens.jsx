// Customer app "Me" area: profile hub, rewards, settings, edit profile and
// about. App.jsx owns all state; these screens receive it through `ctx` so the
// shop logic stays in one place and the screens stay presentational.
import React, { useState } from 'react';
import { ScreenHeader, SettingsGroup, SettingsRow, Toggle, Segmented, PillButton, ConfirmSheet } from '../components/SettingsKit';
import { APP_VERSION } from '../version.generated';

const money = (n) => 'KES ' + Math.round(n || 0).toLocaleString('en-KE');
const TIER_ICON = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Platinum: '💎' };

// ---------- ME (profile hub) ----------
export function MeScreen({ ctx }) {
  const { customer, profile, Avatar, custAccount, custLoyalty, go, myOrders, favorites, cartCount, openWallet } = ctx;
  const tier = custAccount?.tier || custLoyalty?.tier || 'Bronze';
  const points = custLoyalty?.points ?? custAccount?.loyaltyPoints ?? 0;
  const activeOrders = (myOrders || []).filter(o => ['pending', 'packed', 'on_the_way'].includes(o.status)).length;
  const unusedVouchers = (custAccount?.vouchers || []).filter(v => !v.used).length;
  return (
    <>
      <ScreenHeader title="Me" right={
        <button type="button" className="ui-header-back" aria-label="Settings" onClick={() => go('settings')} style={{ fontSize: '1.15rem' }}>⚙️</button>
      } />
      <div className="ui-page">
        <button type="button" className="ui-hero" onClick={() => go('edit-profile')} style={{ width: '100%', textAlign: 'left', color: 'inherit', fontFamily: 'inherit', cursor: 'pointer' }}>
          <Avatar profile={profile} size={64} />
          <div className="ui-hero-text">
            <h2>{profile?.name || customer?.name || 'Shopper'}</h2>
            <p>📱 {customer?.customerId}</p>
            <span className="ui-chip">{TIER_ICON[tier] || '⭐'} {tier} member</span>
          </div>
          <span className="ui-row-chevron">›</span>
        </button>

        <div className="ui-wallet">
          <div className="ui-wallet-row">
            <div><small>Wallet cash</small><b>{money(custAccount?.walletBalance)}</b></div>
            <div style={{ textAlign: 'right' }}><small>Points</small><b>{points.toLocaleString('en-KE')}</b></div>
          </div>
          <div className="ui-wallet-actions">
            <button type="button" onClick={openWallet}>🪙 Convert points</button>
            <button type="button" onClick={() => go('rewards')}>🎁 Rewards store</button>
          </div>
        </div>

        <div className="ui-quick">
          <button type="button" onClick={() => go('orders')}><span>📦</span>Orders{activeOrders > 0 && <i className="ui-badge">{activeOrders}</i>}</button>
          <button type="button" onClick={() => go('favorites')}><span>❤️</span>Favorites{favorites?.length > 0 && <i className="ui-badge">{favorites.length}</i>}</button>
          <button type="button" onClick={() => go('rewards')}><span>🎟️</span>Vouchers{unusedVouchers > 0 && <i className="ui-badge">{unusedVouchers}</i>}</button>
          <button type="button" onClick={() => go('cart')}><span>🛒</span>Cart{cartCount > 0 && <i className="ui-badge">{cartCount}</i>}</button>
        </div>

        {custAccount?.outstandingDebt > 0 && (
          <SettingsGroup>
            <SettingsRow icon="⚠️" tone="red" label={`Outstanding balance ${money(custAccount.outstandingDebt)}`} sub="Please clear it at the counter to keep your account in good standing." />
          </SettingsGroup>
        )}

        <SettingsGroup title="My shopping">
          <SettingsRow icon="📦" tone="orange" label="My orders" sub="Track deliveries and past orders" onClick={() => go('orders')} />
          <SettingsRow icon="🎁" tone="gold" label="Rewards & vouchers" sub={`${points.toLocaleString('en-KE')} points · ${unusedVouchers} voucher${unusedVouchers === 1 ? '' : 's'}`} onClick={() => go('rewards')} />
          <SettingsRow icon="👥" tone="green" label="Invite friends" sub="You both earn bonus points" onClick={() => go('referral')} />
          <SettingsRow icon="🏷️" tone="purple" label="Offers & promos" onClick={() => go('offers')} />
        </SettingsGroup>

        <SettingsGroup title="Account">
          <SettingsRow icon="📊" label="Account summary" value={custAccount ? `${custAccount.orderCount || 0} orders · ${money(custAccount.totalSpent)}` : ''} />
          {custAccount?.memberSince && <SettingsRow icon="📅" label="Member since" value={new Date(custAccount.memberSince).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', month: 'short', year: 'numeric' })} />}
          <SettingsRow icon="⚙️" label="Settings" sub="Notifications, delivery, updates, privacy" onClick={() => go('settings')} />
        </SettingsGroup>

        <SettingsGroup title="Help">
          <SettingsRow icon="⭐" label="Rate us / send feedback" onClick={() => go('review')} />
          <SettingsRow icon="📲" label="Share the app" onClick={() => go('share')} />
          <SettingsRow icon="ℹ️" label="About BlitzMall" onClick={() => go('about')} />
        </SettingsGroup>
      </div>
    </>
  );
}

// ---------- REWARDS ----------
export function RewardsScreen({ ctx }) {
  const { custAccount, custLoyalty, loyaltyRewards, redeemReward, openWallet, goBack, showToast } = ctx;
  const points = custLoyalty?.points ?? custAccount?.loyaltyPoints ?? 0;
  const vouchers = custAccount?.vouchers || [];
  const unused = vouchers.filter(v => !v.used);
  const copy = (code) => { try { navigator.clipboard && navigator.clipboard.writeText(code); } catch (e) {} showToast(`Copied ${code} — paste it at checkout`); };
  const describe = (v) => v.type === 'percent' ? `${v.value}% off` : v.type === 'free_delivery' ? 'Free delivery' : `KES ${v.value} off`;
  return (
    <>
      <ScreenHeader title="Rewards" onBack={goBack} />
      <div className="ui-page">
        <div className="ui-wallet">
          <div className="ui-wallet-row">
            <div><small>{custLoyalty?.tier || custAccount?.tier || 'Bronze'} tier</small><b>{points.toLocaleString('en-KE')} pts</b></div>
            <div style={{ textAlign: 'right' }}><small>Wallet cash</small><b>{money(custAccount?.walletBalance)}</b></div>
          </div>
          <div className="ui-wallet-actions">
            <button type="button" onClick={openWallet}>🪙 Convert points to cash</button>
          </div>
        </div>

        <SettingsGroup title="Redeem points" footer="Earn 1 point for every KES 200 you spend. Coupons are tied to your number and work once.">
          {(loyaltyRewards || []).length === 0 && <div className="ui-empty"><span>🎁</span>The rewards store is loading…</div>}
          {(loyaltyRewards || []).map(r => (
            <SettingsRow key={r._id} icon="🎟️" tone="gold" label={r.name} sub={`${r.pointsCost} points`}
              right={<PillButton disabled={points < r.pointsCost} onClick={() => redeemReward(r._id)}>Redeem</PillButton>} />
          ))}
        </SettingsGroup>

        <SettingsGroup title={`My vouchers (${unused.length})`}>
          {unused.length === 0 && <div className="ui-empty"><span>🎟️</span>No unused vouchers. Spin the wheel or redeem points to win some.</div>}
          {unused.map(v => (
            <SettingsRow key={v.code} icon="🏷️" tone="orange" label={v.code}
              sub={`${describe(v)}${v.minPurchase ? ` · min ${money(v.minPurchase)}` : ''}${v.expiresAt ? ` · expires ${new Date(v.expiresAt).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}` : ''}`}
              right={<PillButton kind="ghost" onClick={() => copy(v.code)}>Copy</PillButton>} />
          ))}
        </SettingsGroup>
      </div>
    </>
  );
}

// ---------- EDIT PROFILE ----------
export function EditProfileScreen({ ctx }) {
  const { profile, customer, saveProfile, onUpload, AVATARS, getAvatarSrc, Avatar, goBack, showToast } = ctx;
  const [name, setName] = useState(profile?.name || customer?.name || '');
  const save = () => {
    const clean = name.trim().slice(0, 40);
    if (!clean) { showToast('Please enter your name'); return; }
    saveProfile({ ...(profile || {}), name: clean });
    showToast('✅ Profile saved');
    goBack();
  };
  return (
    <>
      <ScreenHeader title="Edit profile" onBack={goBack} right={<PillButton onClick={save}>Save</PillButton>} />
      <div className="ui-page">
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}><Avatar profile={profile} size={96} /></div>
        <SettingsGroup title="Photo">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: 14, alignItems: 'center' }}>
            {AVATARS.map(a => (
              <button key={a.id} type="button" className={`avatar-pick ${profile?.avatarId === a.id && !profile?.photo ? 'sel' : ''}`}
                onClick={() => saveProfile({ ...(profile || {}), avatarId: a.id, photo: null })}>
                <img src={getAvatarSrc(a.src)} alt={a.id} />
              </button>
            ))}
            <label className="avatar-upload" title="Upload a photo">＋<input type="file" accept="image/*" onChange={onUpload} hidden /></label>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Details" footer="Your phone number is your account — points, wallet, vouchers and orders live under it. To use a different number, sign out and sign in with the new one.">
          <div className="ui-field">
            <label htmlFor="ui-name">Display name</label>
            <input id="ui-name" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Your name" />
          </div>
          <SettingsRow icon="📱" label="Phone number" value={customer?.customerId} />
        </SettingsGroup>
      </div>
    </>
  );
}

// ---------- SETTINGS ----------
export function SettingsScreen({ ctx }) {
  const {
    customer, goBack, go,
    notifEnabled, enablePush, disablePush, sendTestPush, testPushBusy,
    perfMode, setPerfMode, defaultArea, setDefaultArea,
    pendingOfflineOrders, syncOfflineOrders, clearCachedData,
    update, bundleVersion, isNativeApp, isDesktopApp,
    shopInfo, signOut, signOutEverywhere, exitApp
  } = ctx;
  const [confirm, setConfirm] = useState(null); // 'signout' | 'everywhere' | 'clear' | 'exit'
  const phoneDigits = (shopInfo?.phone || '').replace(/[^0-9]/g, '');
  const intl = phoneDigits.startsWith('0') ? '254' + phoneDigits.slice(1) : phoneDigits;
  const mapsUrl = shopInfo?.coords ? `https://www.google.com/maps/dir/?api=1&destination=${shopInfo.coords.lat},${shopInfo.coords.lng}` : null;
  const open = (url) => { try { window.open(url, '_blank', 'noopener'); } catch (e) {} };
  const versionLabel = `v${APP_VERSION}${update.pcAppVersion ? ` (desktop ${update.pcAppVersion})` : ''}`;

  return (
    <>
      <ScreenHeader title="Settings" onBack={goBack} />
      <div className="ui-page">
        <SettingsGroup title="Account">
          <SettingsRow icon="👤" tone="orange" label="Edit profile" sub="Name and photo" onClick={() => go('edit-profile')} />
          <SettingsRow icon="📱" label="Signed in as" value={customer?.customerId} />
        </SettingsGroup>

        <SettingsGroup title="Notifications" footer="Order updates, payment confirmations, prizes and new offers.">
          <SettingsRow icon="🔔" tone="gold" label="Push notifications" sub={notifEnabled ? 'On for this device' : 'Off'}
            right={<Toggle checked={notifEnabled} label="Push notifications" onChange={(v) => (v ? enablePush() : disablePush())} />} />
          <SettingsRow icon="🧪" label="Send a test notification" sub="Check that alerts reach this device"
            right={<PillButton kind="ghost" disabled={!notifEnabled || testPushBusy} onClick={sendTestPush}>{testPushBusy ? 'Sending…' : 'Test'}</PillButton>} />
        </SettingsGroup>

        <SettingsGroup title="Shopping" footer="Pre-selected at checkout. Mall Area delivery is free; standard delivery starts at KES 150 and baskets over KES 1,500 ride free.">
          <SettingsRow icon="🚚" tone="green" label="Default delivery"
            right={<Segmented value={defaultArea} onChange={setDefaultArea} options={[{ value: 'mall', label: 'Mall Area' }, { value: 'standard', label: 'Standard' }]} />} />
        </SettingsGroup>

        <SettingsGroup title="Display">
          <SettingsRow icon="⚡" tone="purple" label="Performance mode" sub="Fewer animations and blur effects — smoother on older phones"
            right={<Toggle checked={perfMode} label="Performance mode" onChange={setPerfMode} />} />
        </SettingsGroup>

        <SettingsGroup title="Storage & data">
          <SettingsRow icon="📤" label="Orders waiting to send" sub="Orders placed while offline are sent automatically when you reconnect"
            value={String(pendingOfflineOrders)}
            right={pendingOfflineOrders > 0 ? <PillButton kind="ghost" onClick={syncOfflineOrders}>Send now</PillButton> : null} />
          <SettingsRow icon="🧹" label="Clear cached data" sub="Re-downloads products and order history. Your account is untouched." onClick={() => setConfirm('clear')} />
        </SettingsGroup>

        <SettingsGroup title="App" footer={update.status || null}>
          <SettingsRow icon="🔄" tone="blue" label="Check for updates" sub={isNativeApp ? 'Updates download in the background and apply next time you open the app' : isDesktopApp ? 'The desktop app updates itself and restarts' : 'The web app is always up to date'}
            right={<PillButton onClick={update.check} disabled={update.checking}>{update.checking ? 'Checking…' : 'Check'}</PillButton>} />
          {update.pcLatest && (
            <SettingsRow icon="⬇️" tone="orange" label={`Download v${update.pcLatest.version}`} sub="Opens the installer download" onClick={update.openDownload} />
          )}
          {update.ready && (
            <SettingsRow icon="🚀" tone="green" label="Restart to update" sub={update.restartIn > 0 ? `Restarting automatically in ${update.restartIn}s` : 'The new version is downloaded'}
              right={<PillButton kind="success" onClick={update.apply}>Restart</PillButton>} />
          )}
          <SettingsRow icon="🏷️" label="Version" value={versionLabel} />
          {bundleVersion && <SettingsRow icon="📦" label="Content bundle" value={bundleVersion} />}
        </SettingsGroup>

        <SettingsGroup title="Help & support">
          {phoneDigits && <SettingsRow icon="📞" tone="green" label="Call the shop" value={shopInfo.phone} onClick={() => open(`tel:${phoneDigits}`)} />}
          {phoneDigits && <SettingsRow icon="💬" tone="green" label="Chat on WhatsApp" onClick={() => open(`https://wa.me/${intl}`)} />}
          {mapsUrl && <SettingsRow icon="📍" tone="red" label="Directions to Blitz Mall" sub={shopInfo?.location || 'Matunda, Kakamega'} onClick={() => open(mapsUrl)} />}
          <SettingsRow icon="⭐" tone="gold" label="Rate us / send feedback" onClick={() => go('review')} />
          <SettingsRow icon="📲" label="Share the app" onClick={() => go('share')} />
        </SettingsGroup>

        <SettingsGroup title="About">
          <SettingsRow icon="ℹ️" label="About BlitzMall" onClick={() => go('about')} />
          <SettingsRow icon="🔒" label="Privacy & terms" onClick={() => go('about')} />
        </SettingsGroup>

        <SettingsGroup title="Sign out" footer="Signing out everywhere ends the session on every phone, PC and browser using this number.">
          <SettingsRow icon="↩️" label="Sign out" danger onClick={() => setConfirm('signout')} />
          <SettingsRow icon="🛡️" label="Sign out of all devices" danger onClick={() => setConfirm('everywhere')} />
          {isNativeApp && <SettingsRow icon="🚪" label="Close the app" danger onClick={() => setConfirm('exit')} />}
        </SettingsGroup>
      </div>

      <ConfirmSheet open={confirm === 'signout'} title="Sign out?" message="Your points, wallet and orders stay on your number — sign back in any time with a code." confirmLabel="Sign out" danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); signOut(); }} />
      <ConfirmSheet open={confirm === 'everywhere'} title="Sign out of all devices?" message="Every phone, PC and browser signed in with this number will need a new code." confirmLabel="Sign out everywhere" danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); signOutEverywhere(); }} />
      <ConfirmSheet open={confirm === 'clear'} title="Clear cached data?" message="Products and order history are downloaded again. Your cart and account are kept." confirmLabel="Clear"
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); clearCachedData(); }} />
      <ConfirmSheet open={confirm === 'exit'} title="Close BlitzMall?" confirmLabel="Close" danger
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); exitApp(); }} />
    </>
  );
}

// ---------- ABOUT ----------
export function AboutScreen({ ctx }) {
  const { goBack, BlitzLogo, update } = ctx;
  return (
    <>
      <ScreenHeader title="About" onBack={goBack} />
      <div className="ui-page">
        <div className="ui-about-hero">
          <BlitzLogo size={72} />
          <h1>BLITZ<b>MALL</b></h1>
          <p>Version {APP_VERSION}{update?.pcAppVersion ? ` · desktop ${update.pcAppVersion}` : ''}</p>
          <p>Matunda, Kakamega</p>
        </div>
        <SettingsGroup title="Privacy">
          <div className="ui-prose">
            <p><b>What we keep.</b> Your name, phone number, delivery addresses and map pin you choose to share, your orders, loyalty points, wallet and vouchers.</p>
            <p style={{ marginTop: 8 }}><b>Why.</b> To deliver your orders, run the loyalty programme and send the notifications you switch on. We never sell your data.</p>
            <p style={{ marginTop: 8 }}><b>Your account is your number.</b> Signing in always needs a one-time code sent to that phone. You can sign out of every device from Settings.</p>
            <p style={{ marginTop: 8 }}><b>Payments.</b> M-Pesa payments are confirmed directly with Safaricom; we never see your M-Pesa PIN.</p>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Terms">
          <div className="ui-prose">
            <p>Prices and stock are confirmed when you check out. Delivery outside the Mall Area is confirmed by the shop before dispatch. Vouchers and wallet cash are tied to your number, are not transferable and have no cash value. Points are earned on delivered orders (1 point per KES 200) and are removed if an order is cancelled or refunded.</p>
          </div>
        </SettingsGroup>
        <p className="ui-group-footer" style={{ textAlign: 'center', marginTop: 18 }}>© {new Date().getFullYear()} Blitz Mall. Made in Kenya 🇰🇪</p>
      </div>
    </>
  );
}
