`include "uvm_macros.svh"
import uvm_pkg::*;

class smoke_test extends uvm_test;
  `uvm_component_utils(smoke_test)

  function new(string name = "smoke_test", uvm_component parent = null);
    super.new(name, parent);
  endfunction

  task run_phase(uvm_phase phase);
    bit do_fail;
    phase.raise_objection(this);
    do_fail = $test$plusargs("FAIL");

    `uvm_info("SMOKE", "Starting smoke test", UVM_LOW)
    #10;
    `uvm_warning("SMOKE", "Latency higher than expected (12ns)")
    #10;

    if (do_fail) begin
      `uvm_error("SMOKE", "Data mismatch: expected 32'hDEAD_BEEF got 32'h0000_0000")
    end

    `uvm_info("SMOKE", "Smoke test complete", UVM_LOW)
    phase.drop_objection(this);
  endtask
endclass

module uvm_smoke_test_top;
  initial begin
    run_test("smoke_test");
  end
endmodule
