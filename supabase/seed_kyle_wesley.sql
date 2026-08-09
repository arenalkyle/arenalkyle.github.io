-- Migrates Kyle and Wesley's existing hard-coded rankings into the
-- new per-user rankings table, and promotes them to real Admin/Editor
-- accounts. Run this ONCE, after:
--   1. schema.sql has been run
--   2. Kyle and Wesley have each signed up for a real account on the
--      site (email/password or Google -- doesn't matter which)
--
-- Swap the usernames below for whatever they actually chose at sign-up,
-- and swap the roles if you'd rather they land the other way around.

-- one-time helper: seeds a user's rankings table from an ordered
-- array of player_keys, bypassing the create_edit_own_rankings
-- permission check in replace_user_rankings() (useful for this kind
-- of one-off admin migration). Drops itself at the end of this file.
create or replace function public.__seed_rankings_by_username(target_username text, player_keys text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid;
begin
  select id into uid from public.profiles where username = target_username;
  if uid is null then
    raise exception 'no profile found for username %s -- have they signed up yet?', target_username;
  end if;

  delete from public.rankings where owner_id = uid;
  insert into public.rankings (owner_id, player_key, rank, updated_at)
  select uid, pk, ord, now()
  from unnest(player_keys) with ordinality as t(pk, ord);

  update public.profiles set role = case
    when target_username = 'kyle' then 'admin'
    when target_username = 'wesley' then 'editor'
    else role
  end where username = target_username;
end;
$$;

select public.__seed_rankings_by_username('kyle',
  ARRAY['jahmyr gibbs|DET','bijan robinson|ATL','puka nacua|LAR','ja''marr chase|CIN','christian mccaffrey|SF','amon-ra st. brown|DET','jaxon smith-njigba|SEA','justin jefferson|MIN','jonathan taylor|IND','ceedee lamb|DAL','james cook|BUF','omarion hampton|LAC','kenneth walker|KC','saquon barkley|PHI','ashton jeanty|LV','derrick henry|BAL','drake london|ATL','chase brown|CIN','trey mcbride|ARI','devon achane|MIA','jeremiyah love|ARI','brock bowers|LV','a.j. brown|NE','malik nabers|NYG','nico collins|HOU','rashee rice|KC','george pickens|DAL','breece hall|NYJ','chris olave|NO','tee higgins|CIN','josh jacobs|GB','devonta smith|PHI','javonte williams|DAL','kyren williams|LAR','josh allen|BUF','emeka egbuka|TB','ladd mcconkey|LAC','davante adams|LAR','cam skattebo|NYG','zay flowers|BAL','garrett wilson|NYJ','jaylen waddle|DEN','travis etienne|NO','tetairoa mcmillan|CAR','terry mclaurin|WAS','d''andre swift|CHI','bucky irving|TB','mike evans|SF','luther burden|CHI','quinshon judkins|CLE','bhayshul tuten|JAX','treveyon henderson|NE','lamar jackson|BAL','jadarian price|SEA','david montgomery|HOU','carnell tate|TEN','jameson williams|DET','colston loveland|CHI','rome odunze|CHI','tyler warren|IND','brian thomas|JAX','dj moore|BUF','jaylen warren|PIT','christian watson|GB','marvin harrison|ARI','jayden daniels|WAS','joe burrow|CIN','jordyn tyson|NO','jalen hurts|PHI','caleb williams|CHI','tucker kraft|GB','george kittle|SF','makai lemon|PHI','drake maye|NE','tony pollard|TEN','alec pierce|IND','parker washington|JAX','chuba hubbard|CAR','rhamondre stevenson|NE','sam laporta|DET','dk metcalf|PIT','michael pittman|PIT','chris godwin|TB','quentin johnston|LAC','kyle pitts|ATL','jaxson dart|NYG','brock purdy|SF','patrick mahomes|KC','jonathon brooks|CAR']::text[]
);

select public.__seed_rankings_by_username('wesley',
  ARRAY['jahmyr gibbs|DET','bijan robinson|ATL','ja''marr chase|CIN','puka nacua|LAR','jaxon smith-njigba|SEA','amon-ra st. brown|DET','christian mccaffrey|SF','jonathan taylor|IND','ceedee lamb|DAL','justin jefferson|MIN','james cook|BUF','ashton jeanty|LV','omarion hampton|LAC','devon achane|MIA','saquon barkley|PHI','a.j. brown|NE','nico collins|HOU','chase brown|CIN','drake london|ATL','george pickens|DAL','devonta smith|PHI','trey mcbride|ARI','derrick henry|BAL','josh jacobs|GB','kyren williams|LAR']::text[]
);

drop function public.__seed_rankings_by_username(text, text[]);
