<script lang='ts'>
	let { children } = $props()
</script>

<svelte:head>
	<title>NIPBANG Kotaete</title>
	<meta name='description' content='NIPBANG Kotaete — Live Quiz Spectator' />
</svelte:head>

{@render children()}
