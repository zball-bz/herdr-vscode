use super::*;

#[test]
fn edge_columns_reach_over_the_hosts_margins() {
    let (lead, reach) = (px(4.), px(107.));
    // A row of ten 10 px cells, the host's margins 4 px left and 7 px right.
    assert_eq!(span_edges(0..3, 10, 10., lead, reach), (px(-4.), px(30.)));
    assert_eq!(span_edges(3..7, 10, 10., lead, reach), (px(30.), px(70.)));
    assert_eq!(span_edges(7..10, 10, 10., lead, reach), (px(70.), reach));
    assert_eq!(span_edges(0..10, 10, 10., lead, reach), (px(-4.), reach));
    // Without a margin the first column starts at the grid.
    assert_eq!(span_edges(0..1, 10, 10., px(0.), reach), (px(0.), px(10.)));
}
